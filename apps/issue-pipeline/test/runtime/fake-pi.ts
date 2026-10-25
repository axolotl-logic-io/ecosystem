// A fake `pi --mode rpc` for the buddy flow tests: no model runs. Each
// launch takes the next session of the plan in FAKE_PI_PLAN, logs its
// arguments and prompt to FAKE_PI_LOG and plays the session over pi's RPC
// stdio. A committing session writes its file in the code checkout and
// commits it through the real pipeline_commit extension the launch loads
// (`-e .../pipeline-commit.mjs`), which asks the action's push server to
// push. While it runs, a session can change the fake GitHub world as a
// person or GitHub would (`change`), and can wait for the runtime's abort
// instead of replying.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readWorld, writeWorld } from "../signals/fake-github-world.ts";

const SESSION = z.strictObject({
  commit: z
    .strictObject({
      file: z.string(),
      content: z.string(),
      message: z.string(),
    })
    .nullable(),
  // What changes on GitHub while the session runs: the human applies
  // agents:stop to the issue, the human leaves the organization, or GitHub
  // starts failing every comment POST before it applies.
  change: z.enum(["stop-issue", "human-leaves", "posts-fail"]).nullable(),
  // Wait for the runtime's abort command rather than replying.
  awaitAbort: z.boolean(),
  reply: z.record(z.string(), z.unknown()).nullable(),
});
const PLAN = z.strictObject({ next: z.int(), sessions: z.array(SESSION) });
const HUMAN = "autumn";
const ISSUE = 7;
const PROFILE = z.looseObject({
  proxy: z.looseObject({ endpoint: z.string() }),
});
const CACHE = z.looseObject({
  discovery: z.looseObject({
    builtinProviders: z.array(
      z.looseObject({
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
  if (result.isError) {
    throw new Error(`pipeline_commit failed: ${JSON.stringify(result)}`);
  }
}

// Makes `change` in the world; the human is autumn, the item issue 7.
function applyChange(change: NonNullable<Session["change"]>): void {
  const file = env("FAKE_GH_WORLD");
  const world = readWorld(file);
  if (change === "posts-fail") {
    world.post = "lost-before-apply";
  } else if (change === "human-leaves") {
    world.members = world.members.filter((item) => item.login !== HUMAN);
  } else {
    const issue = world.issues.find((item) => item.number === ISSUE);
    if (issue === undefined) {
      throw new Error(`the world has no issue ${ISSUE}`);
    }
    issue.labels.push("agents:stop");
    issue.events.push({
      id: world.nextId,
      event: "labeled",
      label: "agents:stop",
      actor: HUMAN,
      viaApp: false,
      createdAt: "2026-10-25T13:00:00Z",
    });
    world.nextId += 1;
  }
  writeWorld(file, world);
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
  if (session.commit !== null) {
    await commitThrough(args, session.commit);
  }
  if (session.change !== null) {
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
  const [entry] = cache.discovery.builtinProviders;
  const cached = entry?.models.find((item) => item.id === id);
  return {
    model: {
      provider,
      id,
      contextWindow: cached?.contextWindow ?? 0,
      baseUrl: config.proxy.endpoint,
      api: entry?.api,
    },
    autoCompactionEnabled: true,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--version") {
    process.stdout.write("1.2.0\n");
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
  fs.appendFileSync(
    env("FAKE_PI_LOG"),
    `${JSON.stringify({ args, prompt: prompt.message ?? "", cwd: process.cwd() })}\n`,
  );
  await play(args, session, commands);
  lines.close();
}

await main();
