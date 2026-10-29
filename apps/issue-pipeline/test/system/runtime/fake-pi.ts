// A fake `pi --mode rpc` for the buddy flow tests: no model runs. Each
// launch takes the next session of the plan in FAKE_PI_PLAN, logs its
// arguments, prompt, folder and the ISSUE_PIPELINE_LANE_SLOT it inherited
// to FAKE_PI_LOG and plays the session over pi's RPC stdio. A committing
// session writes its file in the code checkout and commits it through the
// real pipeline_commit extension the launch loads
// (`-e .../pipeline-commit.mjs`), which asks the action's push server to
// push, and appends the tool's result to FAKE_PI_COMMITS. While it runs, a
// session can change the fake GitHub world as a person or GitHub would
// (`change`), through the fake GitHub server on FAKE_GH_SOCKET, write
// outside any commit (`strayWrite`), resolve and stage a conflicted file as
// its prompt page allows (`resolve`), and can wait for the runtime's abort
// instead of replying.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { changeWorld } from "../../support/signals/fake-github-test-kit.ts";
import type { World } from "../../support/signals/fake-github-world.ts";

const SESSION = z.strictObject({
  commit: z
    .strictObject({
      file: z.string(),
      content: z.string(),
      message: z.string(),
    })
    .nullable(),
  // What changes on GitHub while the session runs: the human applies
  // agents:stop to the issue, the human leaves the organization, GitHub
  // starts failing every comment POST before it applies, or only those of
  // the action's state checkpoint, or the issue's label events become
  // unreadable, or another worker pushes its own commit to the issue's
  // branch.
  change: z
    .enum([
      "stop-issue",
      "human-leaves",
      "posts-fail",
      "checkpoint-posts-fail",
      "events-unreadable",
      "comments-unreadable",
      "rival-push",
      "reapply-author-start",
      "apply-verify-start",
    ])
    .nullable(),
  // Whether `change` comes before the commit rather than after it.
  changeFirst: z.boolean(),
  // A file the session writes in the code checkout and leaves uncommitted,
  // as a stray write by a session declared read-only.
  strayWrite: z
    .strictObject({ file: z.string(), content: z.string() })
    .optional(),
  // A conflicted file the session writes and stages, the one git write a
  // Fix session's page allows.
  resolve: z.strictObject({ file: z.string(), content: z.string() }).optional(),
  // Wait for the runtime's abort command rather than replying.
  awaitAbort: z.boolean(),
  reply: z.record(z.string(), z.unknown()).nullable(),
});
const PLAN = z.strictObject({ next: z.int(), sessions: z.array(SESSION) });
const HUMAN = "autumn";
const ISSUE = 7;
const TRAILING_SLASHES = /\/+$/u;
const V1_SUFFIX = /\/v1$/u;
const PROFILE = z.looseObject({
  proxy: z.looseObject({ endpoint: z.string() }),
});
const CACHE = z.looseObject({
  discovery: z.looseObject({
    builtinProviders: z.array(
      z.looseObject({
        name: z.string(),
        api: z.string(),
        models: z.array(
          z.looseObject({ id: z.string(), contextWindow: z.number() }),
        ),
      }),
    ),
  }),
});
const COMMAND = z.looseObject({
  id: z.string().optional(),
  type: z.string(),
  message: z.string().optional(),
});
const TOOL_RESULT = z.looseObject({ isError: z.boolean() });

// The parts of pi's extension API that pipeline_commit uses.
interface CommitTool {
  execute: (id: string, params: unknown) => Promise<unknown>;
}
type Register = (pi: { registerTool: (tool: CommitTool) => void }) => void;
const REGISTERING = z.object({ default: z.unknown() });

// An extension's default export is its registration function.
function isRegister(value: unknown): value is Register {
  return typeof value === "function";
}

type Session = z.infer<typeof SESSION>;

function env(name: string): string {
  const { [name]: value } = process.env;
  if (value === undefined || value === "") {
    process.stderr.write(`fake pi: ${name} is not set\n`);
    process.exit(1);
  }
  return value;
}

function emit(record: object): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

// Takes the plan's next session.
function nextSession(file: string): Session {
  const plan = PLAN.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const session = plan.sessions[plan.next];
  if (session === undefined) {
    process.stderr.write(`fake pi: the plan has no session ${plan.next}\n`);
    process.exit(1);
  }
  fs.writeFileSync(file, JSON.stringify({ ...plan, next: plan.next + 1 }));
  return session;
}

function extensionArgs(args: readonly string[]): string[] {
  return args.flatMap((arg, at) => {
    const next = args[at + 1];
    if (arg === "-e" && next !== undefined) {
      return [next];
    }
    return [];
  });
}

// Commits `commit` through the launch's pipeline_commit extension.
async function commitThrough(
  args: readonly string[],
  commit: NonNullable<Session["commit"]>,
): Promise<void> {
  const extension = extensionArgs(args).find((file) =>
    file.endsWith("pipeline-commit.mjs"),
  );
  if (extension === undefined) {
    throw new Error("this launch has no pipeline_commit extension");
  }
  fs.writeFileSync(path.join("repo", commit.file), commit.content);
  const loaded: unknown = await import(pathToFileURL(extension).href);
  const register = REGISTERING.parse(loaded).default;
  if (!isRegister(register)) {
    throw new Error("pipeline-commit.mjs exports no extension");
  }
  const tools: CommitTool[] = [];
  register({
    registerTool: (registered: CommitTool) => tools.push(registered),
  });
  const [tool] = tools;
  if (tool === undefined) {
    throw new Error("pipeline_commit registered no tool");
  }
  const result = TOOL_RESULT.parse(
    await tool.execute("commit-1", {
      args: ["-m", commit.message, "--", `repo/${commit.file}`],
    }),
  );
  fs.appendFileSync(env("FAKE_PI_COMMITS"), `${JSON.stringify(result)}\n`);
}

// Writes `resolved` over its conflicted file and stages it.
function resolveConflict(resolved: NonNullable<Session["resolve"]>): void {
  fs.writeFileSync(path.join("repo", resolved.file), resolved.content);
  const staged = spawnSync("git", ["-C", "repo", "add", "--", resolved.file], {
    encoding: "utf8",
  });
  if (staged.status !== 0) {
    throw new Error(`staging ${resolved.file} failed: ${staged.stderr}`);
  }
}

function gitOk(args: readonly string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Another worker's commit on issue 7's branch, pushed straight to the
// checkout's origin from a clone of its own.
function rivalPush(): void {
  const origin = gitOk(["-C", "repo", "remote", "get-url", "origin"]);
  const head = gitOk(["-C", "repo", "rev-parse", "HEAD"]);
  const rival = fs.mkdtempSync(path.join(path.dirname(origin), "rival-"));
  gitOk(["clone", "--quiet", origin, rival]);
  fs.writeFileSync(path.join(rival, "rival.txt"), "another worker\n");
  for (const args of [
    ["checkout", "--quiet", "-b", `agent/issue-${ISSUE}`, head],
    ["add", "rival.txt"],
    [
      "-c",
      "user.name=Rival",
      "-c",
      "user.email=rival@example.invalid",
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "Another worker's commit",
    ],
    ["push", "--quiet", "origin", `HEAD:refs/heads/agent/issue-${ISSUE}`],
  ]) {
    gitOk(["-C", rival, ...args]);
  }
  fs.rmSync(rival, { recursive: true, force: true });
}

// Makes `change` in the world; the human is autumn, the item issue 7.
function applyChange(change: NonNullable<Session["change"]>): void {
  if (change === "rival-push") {
    rivalPush();
    return;
  }
  changeWorld(env("FAKE_GH_SOCKET"), (world) => edit(world, change));
}

function edit(world: World, change: NonNullable<Session["change"]>): void {
  if (change === "posts-fail") {
    world.post = "lost-before-apply";
  } else if (change === "checkpoint-posts-fail") {
    world.failWritesContaining = "<!-- agent-pipeline:state\n";
  } else if (change === "comments-unreadable") {
    world.faults.push({
      path: `repos/${world.repo}/issues/${ISSUE}/comments`,
      page: null,
      link: null,
      status: 503,
    });
  } else if (change === "events-unreadable") {
    world.faults.push({
      path: `repos/${world.repo}/issues/${ISSUE}/events`,
      page: null,
      status: 502,
      link: null,
    });
  } else if (change === "human-leaves") {
    world.members = world.members.filter((item) => item.login !== HUMAN);
  } else {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    let label = "agents:stop";
    if (change === "apply-verify-start") {
      label = "start:verify";
    }
    if (change === "reapply-author-start") {
      label = "start:author";
    }
    // A person who reapplies a present label removes it first.
    if (issue.labels.includes(label)) {
      issue.events.push({
        id: world.nextId,
        event: "unlabeled",
        label,
        actor: HUMAN,
        viaApp: false,
        createdAt: "2026-10-26T13:00:00Z",
      });
      world.nextId += 1;
    } else {
      issue.labels.push(label);
    }
    issue.events.push({
      id: world.nextId,
      event: "labeled",
      label,
      actor: HUMAN,
      viaApp: false,
      createdAt: "2026-10-26T13:00:00Z",
    });
    world.nextId += 1;
  }
}

// Reads commands until the runtime's abort, which settles the session with
// no reply; or until the runtime closes stdin.
async function untilAbort(commands: AsyncIterator<string>): Promise<void> {
  const line = await commands.next();
  if (line.done === true) {
    return;
  }
  const command = COMMAND.parse(JSON.parse(line.value));
  if (command.type !== "abort") {
    await untilAbort(commands);
    return;
  }
  emit({ type: "response", id: command.id, success: true });
  emit({ type: "agent_settled" });
}

async function play(
  args: readonly string[],
  session: Session,
  commands: AsyncIterator<string>,
): Promise<void> {
  if (session.change !== null && session.changeFirst) {
    applyChange(session.change);
  }
  if (session.resolve !== undefined) {
    resolveConflict(session.resolve);
  }
  if (session.commit !== null) {
    await commitThrough(args, session.commit);
  }
  if (session.strayWrite !== undefined) {
    const { file, content } = session.strayWrite;
    fs.writeFileSync(path.join("repo", file), content);
  }
  if (session.change !== null && !session.changeFirst) {
    applyChange(session.change);
  }
  if (session.awaitAbort) {
    await untilAbort(commands);
    return;
  }
  if (session.reply !== null) {
    emit({
      type: "tool_execution_end",
      toolName: "structured_output",
      result: { details: session.reply },
    });
  }
  emit({ type: "agent_settled" });
}

// pi's state as `get_state` answers it, as far as the runtime reads it.
interface PiState {
  model: {
    provider: string;
    id: string;
    contextWindow: number;
    baseUrl: string;
    api: string | undefined;
  };
  autoCompactionEnabled: true;
}

// The base URL pi-cliproxyapi registers a model at: the endpoint, less its
// trailing /v1 for the Anthropic SDK, which takes the host root.
function baseUrlOf(api: string | undefined, endpoint: string): string {
  const trimmed = endpoint.replace(TRAILING_SLASHES, "");
  if (api === "anthropic-messages") {
    return trimmed.replace(V1_SUFFIX, "");
  }
  return trimmed;
}

// pi's state, as pi answers `get_state` with the provisioned provider
// profile in HOME, the runtime home.
function stateOf(args: readonly string[]): PiState {
  const profile = path.join(env("HOME"), ".pi", "agent", "pi-cliproxyapi");
  const config = PROFILE.parse(
    JSON.parse(fs.readFileSync(path.join(profile, "config.json"), "utf8")),
  );
  const cache = CACHE.parse(
    JSON.parse(
      fs.readFileSync(path.join(profile, "discovery-cache.json"), "utf8"),
    ),
  );
  const model = args[args.indexOf("--model") + 1] ?? "";
  const [provider = "", id = ""] = model.split("/");
  const entry = cache.discovery.builtinProviders.find(
    (item) => item.name === provider,
  );
  const cached = entry?.models.find((item) => item.id === id);
  return {
    model: {
      provider,
      id,
      contextWindow: cached?.contextWindow ?? 0,
      baseUrl: baseUrlOf(entry?.api, config.proxy.endpoint),
      api: entry?.api,
    },
    autoCompactionEnabled: true,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    process.stdout.write("1.4.0\n");
    return;
  }
  const session = nextSession(env("FAKE_PI_PLAN"));
  const lines = readline.createInterface({ input: process.stdin });
  const commands = lines[Symbol.asyncIterator]();
  let first = await commands.next();
  if (first.done !== true) {
    const probe = COMMAND.parse(JSON.parse(first.value));
    if (probe.type === "get_state") {
      emit({
        type: "response",
        id: probe.id,
        command: "get_state",
        success: true,
        data: stateOf(args),
      });
      first = await commands.next();
    }
  }
  if (first.done === true) {
    process.exit(1);
  }
  const prompt = COMMAND.parse(JSON.parse(first.value));
  emit({ type: "response", id: prompt.id, command: "prompt", success: true });
  const { ISSUE_PIPELINE_LANE_SLOT: laneSlot = null } = process.env;
  fs.appendFileSync(
    env("FAKE_PI_LOG"),
    `${JSON.stringify({
      args,
      prompt: prompt.message ?? "",
      cwd: process.cwd(),
      laneSlot,
    })}\n`,
  );
  await play(args, session, commands);
  lines.close();
}

await main();
