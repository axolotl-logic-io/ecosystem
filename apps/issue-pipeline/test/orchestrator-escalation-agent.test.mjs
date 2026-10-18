// @ts-check
// The escalation agent (#282): with `escalationAgent` set, a tick that raises
// escalations runs the agent once, read-only, and logs its recommended action
// for each escalated issue; with the key unset no agent runs. With
// `escalationAgentActs` on, a recommendation is carried out through the
// watchdog's steer, resume and stop. A failed run is logged and the tick goes
// on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectNames, effectsOf } from "./gh-effects.mjs";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  configWith,
  deadPid,
  fakeGh,
  OTHERS_PID,
  SWEEP_STAGE,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig, paths } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");
const { CODEMODE_RULE } = await import("../src/workflow/prompts.ts");

/** @import { ProcessExit } from "../src/job/raw-results.ts" */
/** @import { AgentRunOptions, RunAgent } from "../src/orchestrator/escalation-consult.ts" */

const ISSUE = {
  first: 100,
  second: 101,
  unset: 102,
  quiet: 103,
  steered: 104,
  resumed: 105,
  stopped: 106,
  timedOut: 107,
  threw: 108,
  badReply: 109,
  noDefinition: 110,
  fresh: 111,
  stranger: 120,
};
const AGENT = "issue-pipeline-escalation";
const READ_ONLY = [
  "read",
  "grep",
  "find",
  "ls",
  "codemode",
  "structured_output",
];
const STEER = "Re-read the spec's Tests section and carry on.";

/** @param {object} [extra] */
function agentConfig(extra = {}) {
  return loadConfig(configWith({ escalationAgent: AGENT, ...extra }));
}

/** @param {number} number */
function needsInfo(number) {
  return { number, labels: ["agent:needs-info"] };
}

// A pi exit whose structured output is `details`.
/** @param {object} details @returns {ProcessExit} */
function replied(details) {
  const event = {
    type: "tool_execution_end",
    toolName: "structured_output",
    isError: false,
    result: { details },
  };
  return {
    code: 0,
    stdout: `${JSON.stringify(event)}\n`,
    stderr: "",
    timedOut: false,
  };
}

/** @param {readonly { issue: number, action: object }[]} recommendations */
function recommending(recommendations) {
  return replied({ recommendations });
}

// A fake pi that records each run and ends as `exit`, or throws it.
/** @param {ProcessExit | Error} exit */
function fakeAgent(exit) {
  /** @type {{ argv: string[], options: AgentRunOptions }[]} */
  const runs = [];
  /** @type {RunAgent} */
  function runAgent(argv, options) {
    runs.push({ argv: [...argv], options });
    if (exit instanceof Error) {
      throw exit;
    }
    return exit;
  }
  return { runs, runAgent };
}

/** @param {number} issue @returns {string[]} */
function linesOf(issue) {
  return loggedFor(issue).map(({ action, reason }) => `${action} ${reason}`);
}

// A fake pi whose reply steers `issue`'s session.
/** @param {number} issue */
function steerTo(issue) {
  return fakeAgent(
    recommending([{ issue, action: { kind: "steer", message: STEER } }]),
  );
}

/** @param {string[]} argv @param {string} flag @returns {string | undefined} */
function flagOf(argv, flag) {
  return argv[argv.indexOf(flag) + 1];
}

test("a tick's new escalations run the agent once, read-only with codemode and the codemode rule, and log a recommendation for each issue", () => {
  const config = agentConfig();
  const issues = [needsInfo(ISSUE.first), needsInfo(ISSUE.second)];
  const agent = fakeAgent(
    recommending([
      {
        issue: ISSUE.first,
        action: { kind: "stop", code: "not-doable", reason: "no way" },
      },
      { issue: ISSUE.first, action: { kind: "resume" } },
      { issue: ISSUE.stranger, action: { kind: "resume" } },
    ]),
  );
  tickOver(issues, 0, { config, runAgent: agent.runAgent });
  tickOver(issues, 1, { config, runAgent: agent.runAgent });
  assert.equal(agent.runs.length, 1);
  const [run] = agent.runs;
  assert.ok(run !== undefined);
  assert.equal(flagOf(run.argv, "--mode"), "json");
  const tools = String(flagOf(run.argv, "--tools")).split(",");
  assert.ok(tools.every((tool) => READ_ONLY.includes(tool)));
  assert.ok(tools.includes("codemode"));
  const prompt = String(run.argv.at(-1));
  assert.equal(prompt.split(CODEMODE_RULE).length - 1, 1);
  for (const issue of [ISSUE.first, ISSUE.second]) {
    assert.ok(prompt.includes(`${paths.runDir(config, issue)}/job.json`));
  }
  assert.deepEqual(linesOf(ISSUE.first), [
    "escalated needs-info",
    "recommended stop:not-doable",
  ]);
  assert.deepEqual(linesOf(ISSUE.second), [
    "escalated needs-info",
    "recommended none",
  ]);
  assert.deepEqual(linesOf(ISSUE.stranger), []);
});

test("with escalationAgent unset, escalations run no agent and log no recommendation", () => {
  const agent = fakeAgent(recommending([]));
  tickOver([needsInfo(ISSUE.unset)], 0, { runAgent: agent.runAgent });
  assert.equal(agent.runs.length, 0);
  assert.deepEqual(linesOf(ISSUE.unset), ["escalated needs-info"]);
});

test("a steer is only logged by default, and with escalationAgentActs it reaches the job's live session", () => {
  for (const issue of [ISSUE.quiet, ISSUE.steered]) {
    writeJob({ issue, stage: "implement", pid: OTHERS_PID });
  }
  const off = tickOver([needsInfo(ISSUE.quiet)], 0, {
    config: agentConfig(),
    runAgent: steerTo(ISSUE.quiet).runAgent,
  });
  assert.deepEqual(off.steered, []);
  assert.deepEqual(linesOf(ISSUE.quiet), [
    "escalated needs-info",
    "recommended steer",
  ]);
  const on = tickOver([needsInfo(ISSUE.steered)], 0, {
    config: agentConfig({ escalationAgentActs: true }),
    runAgent: steerTo(ISSUE.steered).runAgent,
  });
  const key = `i${ISSUE.steered}-implement-1`;
  assert.deepEqual(on.steered, [["/tmp/s.sock", key, STEER]]);
  assert.ok(linesOf(ISSUE.steered).includes(`steered agent:${key}`));
});

test("with escalationAgentActs, a resume restarts a dead job at its stage and a stop labels the issue", () => {
  writeJob({
    issue: ISSUE.resumed,
    stage: SWEEP_STAGE,
    pid: deadPid(),
    ended: true,
  });
  const agent = fakeAgent(
    recommending([
      { issue: ISSUE.resumed, action: { kind: "resume" } },
      {
        issue: ISSUE.stopped,
        action: { kind: "stop", code: "not-doable", reason: "it can't be" },
      },
    ]),
  );
  const { spawned } = tickOver(
    [needsInfo(ISSUE.resumed), needsInfo(ISSUE.stopped)],
    0,
    {
      config: agentConfig({ escalationAgentActs: true }),
      runAgent: agent.runAgent,
    },
  );
  const resumes = spawned.filter(
    (argv) => flagOf(argv, "--issue") === String(ISSUE.resumed),
  );
  assert.equal(resumes.length, 1);
  assert.equal(flagOf(resumes[0] ?? [], "--stage"), SWEEP_STAGE);
  assert.ok(resumes[0]?.includes("--resume"));
  assert.ok(linesOf(ISSUE.resumed).includes("resumed agent"));
  const names = effectNames(effectsOf(fakeGh.writes(ghIsRead)));
  assert.ok(names.includes(`label #${ISSUE.stopped} agent:stopped-not-doable`));
  assert.ok(linesOf(ISSUE.stopped).includes("stopped agent:not-doable"));
});

test("a timed-out, throwing, badly replying or undefined agent is logged as failed and the tick goes on", () => {
  const timedOut = { code: null, stdout: "", stderr: "", timedOut: true };
  const cases = [
    { issue: ISSUE.timedOut, exit: timedOut, reason: "timed-out" },
    { issue: ISSUE.threw, exit: new Error("pi crashed"), reason: "failed" },
    {
      issue: ISSUE.badReply,
      exit: replied({ recommendations: "none" }),
      reason: "bad-reply",
    },
  ];
  cases.forEach(({ issue, exit, reason }, at) => {
    const fresh = ISSUE.fresh + at;
    const { spawned } = tickOver([needsInfo(issue), { number: fresh }], at, {
      config: agentConfig(),
      runAgent: fakeAgent(exit).runAgent,
    });
    assert.deepEqual(linesOf(issue), [
      "escalated needs-info",
      `agent-failed ${reason}`,
    ]);
    assert.ok(
      loggedFor(fresh).some(
        ({ action, stage }) => action === "started" && stage === "triage",
      ),
    );
    assert.ok(
      spawned.some((argv) => flagOf(argv, "--issue") === String(fresh)),
    );
  });
  const missing = fakeAgent(recommending([]));
  tickOver([needsInfo(ISSUE.noDefinition)], cases.length, {
    config: agentConfig({ escalationAgent: "issue-pipeline-nobody" }),
    runAgent: missing.runAgent,
  });
  assert.equal(missing.runs.length, 0);
  assert.deepEqual(linesOf(ISSUE.noDefinition), [
    "escalated needs-info",
    "agent-failed no-definition",
  ]);
});
