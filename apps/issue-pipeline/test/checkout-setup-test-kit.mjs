// @ts-check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { endsWithTest } from "./bounded-test-kit.mjs";
import { writeBrain } from "./brain-test-kit.mjs";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { FAKE_PI, outputEnd } from "./fake-rpc-pi.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { seedOrigins } from "./job-git-test-kit.mjs";
import { provisionFixture } from "./runtime-fixtures.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

const { AGENT_DIR } = await import("../src/pipeline-root.ts");
const { loadConfig, paths } = await import("../src/config.ts");
const { newIssueState } = await import("../src/state.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { openBrain } = await import("../src/job/brain.ts");
const { openControl, STOP_GRACE_MS } = await import("../src/job/control.ts");
const { hooksOf } = await import("../src/job/session-hooks.ts");
const { sessionRunnerOf } = await import("../src/job/role-session.ts");
const { runUsage } = await import("../src/job/run-usage.ts");
const { openStatus } = await import("../src/job/status.ts");
const { endGroup } = await import("../src/process-group.ts");
const { STAGE_AGENTS } = await import("../src/job/roles.ts");

const FIXTURE = new URL("./checkout-setup-fixtures.mjs", import.meta.url)
  .pathname;
const SETUP = `node ${JSON.stringify(FIXTURE)} setup`;
const TEST = `node ${JSON.stringify(FIXTURE)} verification`;
const EXAMPLE = "apps/web/.env.test.example";
const ENV_FILE = "apps/web/.env.test";
const BASE_CONTENT = "FIXTURE_TEST=base\n";
const HEAD_CONTENT = "FIXTURE_TEST=issue-head\n";

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
      },
      timeout: 10_000,
      stdio: "pipe",
    },
  ).trim();
}

/** @param {string | null} [setup] */
function world(setup = SETUP) {
  const tmp = fs.mkdtempSync(path.join(isolatedRoot, "setup-"));
  const origins = seedOrigins(tmp, false);
  const seed = `${origins.origin}-seed`;
  fs.mkdirSync(path.join(seed, "apps/web"), { recursive: true });
  fs.writeFileSync(path.join(seed, EXAMPLE), BASE_CONTENT);
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "base example"]);
  git(seed, ["push", "--quiet", origins.origin, "HEAD:integration"]);
  fs.writeFileSync(path.join(seed, EXAMPLE), HEAD_CONTENT);
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "issue example"]);
  git(seed, [
    "push",
    "--quiet",
    origins.origin,
    "HEAD:agent/issue-7",
    "HEAD:agent/issue-8",
  ]);
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  const agents = path.join(AGENT_DIR, "agents/issue-pipeline");
  fs.mkdirSync(agents, { recursive: true });
  for (const { agent } of Object.values(STAGE_AGENTS)) {
    fs.writeFileSync(
      path.join(agents, `${agent}.md`),
      `---\nname: ${agent}\ntools: read, bash\n---\nTest role.\n`,
    );
  }
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: `o/${path.basename(tmp)}`,
      ...credentialConfig("bot"),
      allowedUsers: ["alice"],
      ...origins.config,
      commands: { setup, test: TEST },
      runtime: provisionFixture(tmp),
    }),
  );
  const cfg = loadConfig(config);
  const brainDir = writeBrain(path.join(tmp, "brain"));
  return { tmp, cfg, config, brainDir, bin, origins };
}

/** @param {ReturnType<typeof world>} w @param {import("../src/stages.ts").Stage} stage @param {number} [issue] */
async function roleJob(w, stage, issue = 7) {
  const { cfg, config } = w;
  const branch = `agent/issue-${issue}`;
  const dirs = openJobCheckout(cfg, issue, { stage, branch });
  saveAuthority(cfg, { ...newIssueState(issue), stage, branch }, false, issue);
  const runDir = paths.runDir(cfg, issue);
  const brain = openBrain(w.brainDir, stage);
  const identity = {
    id: `setup-${issue}-${stage}`,
    startedAt: new Date().toISOString(),
  };
  const status = openStatus(runDir, {
    ...identity,
    issue,
    stage,
    lane: null,
    socket: "",
    prompts: brain.pinned,
  });
  const control = await openControl(runDir, () => ({
    pushed: "none",
    pushError: null,
  }));
  endsWithTest(() => control.close());
  const hooks = hooksOf(
    cfg,
    { kind: "run", config, issue, stage, branch, brainPath: w.brainDir },
    { status, control },
    { cwd: dirs.root, repo: dirs.repo, from: modelEnv(w), job: identity },
  );
  trackLaunches(hooks);
  const session = sessionRunnerOf({
    cfg,
    issue,
    stage,
    brain,
    hooks,
    status,
    stopping: control.stopping,
    usage: runUsage(stage, new Date()),
    append: async () => undefined,
  });
  return {
    dirs,
    runDir,
    run: runner(w, { session, stage, issue, branch }),
    control,
  };
}

/** @param {import("../src/job/launch.ts").LaunchHooks} hooks @returns {void} */
function trackLaunches(hooks) {
  const { started } = hooks;
  hooks.started = (launch, live) => {
    started(launch, live);
    if (live.kind === "session") {
      endsWithTest(() => live.session.kill("SIGKILL"));
    } else {
      const { pid, exited } = live.ops;
      endsWithTest(async () => {
        if (pid !== null) {
          await endGroup(pid, exited, STOP_GRACE_MS);
        }
      });
    }
  };
}

/** @param {ReturnType<typeof world>} w @returns {NodeJS.ProcessEnv} */
function modelEnv(w) {
  const { PATH: searchPath = "" } = process.env;
  return {
    ...process.env,
    ...Object.fromEntries([
      ["PATH", `${w.bin}${path.delimiter}${searchPath}`],
      ["FAKE_PI_ROOT", w.tmp],
      ["PIPELINE_MODEL_KEY", "offline-fixture-credential"],
      ["ISSUE_PIPELINE_ISSUE", "incorrect-inherited-issue"],
    ]),
  };
}

/** @param {ReturnType<typeof world>} w @param {{session: ReturnType<typeof sessionRunnerOf>, stage: import("../src/stages.ts").Stage, issue: number, branch: string}} job */
function runner(w, { session, stage, issue, branch }) {
  const { agent, sessions } = STAGE_AGENTS[stage];
  const [allowed] = sessions;
  if (allowed === undefined) {
    throw new Error("stage has no session");
  }
  const spec = {
    agent,
    model: w.cfg.models.author,
    task: "Exercise the configured test environment.",
    schema: z.object({ outcome: z.literal("done") }),
    commits: allowed.commits,
  };
  /** @param {{ probe?: boolean, phase?: import("../src/job/role-context.ts").SessionPhase }} [options] */
  async function run({ probe = true, phase } = {}) {
    // Each concurrent issue has its own saved authority snapshot.
    saveAuthority(
      w.cfg,
      { ...newIssueState(issue), stage, branch },
      false,
      issue,
    );
    let script = { events: [outputEnd({ outcome: "done" })] };
    if (probe) {
      script = { ...script, ...{ probe: [FIXTURE, "role"] } };
    }
    fs.writeFileSync(
      path.join(w.tmp, "pi-script.json"),
      JSON.stringify(script),
    );
    const selectedPhase = phase ?? allowed?.phase ?? undefined;
    const authority = sessions.find(
      (entry) => (entry.phase ?? undefined) === selectedPhase,
    );
    if (authority === undefined) {
      throw new Error("no authority for selected phase");
    }
    if (selectedPhase === undefined) {
      return await session(spec);
    }
    return await session({
      ...spec,
      phase: selectedPhase,
      commits: authority.commits,
    });
  }
  return run;
}

/** @param {ReturnType<typeof world>} w @returns {string} */
function prompts(w) {
  return fs.readFileSync(path.join(w.tmp, "pi.log"), "utf8");
}

export {
  BASE_CONTENT,
  ENV_FILE,
  EXAMPLE,
  FIXTURE,
  git,
  HEAD_CONTENT,
  prompts,
  roleJob,
  world,
};
