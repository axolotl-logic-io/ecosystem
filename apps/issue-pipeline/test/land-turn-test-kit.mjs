// @ts-check
// Exact Lands contending for one target's integration turn (#171): issues
// 7, 8 and 9 in one full-flow world, each at its own revision forked from
// the same target T, with passed Hardening, Integration and Security, ready
// to Land. Each Land is a fresh built ops process bound to its own confirmed
// issue execution, as the merge stage's Land is; landing() starts one that
// runs beside the test, so a gate in the fake GitHub can hold it mid-Land.
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { endsWithTest, killGroup } from "./bounded-test-kit.mjs";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { integrationWorld } from "./integration-task-test-kit.mjs";
import { ownerScript } from "./pipeline-flow-contention-test-kit.mjs";
import { runId } from "./task-results-test-kit.mjs";

// The first contending issue, the integration world's own; the others
// follow it.
const FIRST = 7;
const COORDINATION = "<!-- agent-pipeline:coordination\n";
const TURN_SCOPE = JSON.stringify(["o/r", "integration", "integration"]);
const READ_ONLY_PR = new Set(["view", "list", "checks"]);

/** @typedef {ReturnType<typeof integrationWorld>} IssueWorld */
/** @typedef {IssueWorld & { issue: number, ready: ReturnType<IssueWorld["readyToLand"]> }} Contender */

/**
 * Issue `issue` ready to Land on T, in `flow` when another issue made it.
 * @param {number} issue @param {import("./pipeline-flow-test-kit.mjs").Flow} [flow]
 * @returns {Contender}
 */
function contender(issue, flow) {
  const mine = { file: `issue-${issue}.txt`, bytes: `issue ${issue}\n` };
  const world = integrationWorld(mine, { issue, flow });
  for (const task of ["Hardening", "Integration", "Security"]) {
    world.passed(task);
  }
  return { ...world, issue, ready: world.readyToLand() };
}

/** @returns {[Contender, Contender, Contender]} issues 7, 8 and 9, each ready to Land on T */
function contenders() {
  const first = contender(FIRST);
  return [
    first,
    contender(FIRST + 1, first.flow),
    contender(FIRST + 2, first.flow),
  ];
}

/** @param {Contender} each @returns {object} its exact Land's merge request */
function landRequest(each) {
  return {
    op: "merge",
    number: each.issue,
    state: each.ready.state,
    expectedSha: each.revision,
    expectedBase: each.start,
    revision: each.ready.revision,
    mergeQueue: [each.ready.pr],
    summary: "Exact Land of R on T.",
    binding: each.bound("Land"),
    landRun: { id: runId(), previous: null },
  };
}

/**
 * Starts `each`'s Land in a fresh ops process under a new confirmed issue
 * execution, released once the process ends, as a stage job's would be;
 * resolves to its reply. An acquisition that fails throws at once.
 * @param {Contender} each @returns {Promise<any>}
 */
function landing(each) {
  const { flow, issue } = each;
  const execution = JSON.parse(ownerScript(flow, "owner", { issue }));
  const checkout = {
    issue,
    dir: path.join(flow.root, "work", "o__r", `issue-${issue}`),
    branch: each.branch,
  };
  const body = JSON.stringify({
    config: flow.config,
    ...landRequest(each),
    checkout,
    execution,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(flow.root, "ops.mjs")], {
      env: flow.env,
      detached: true,
    });
    endsWithTest(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        killGroup(child.pid);
      }
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      /** @type {unknown[]} */
      const failures = [];
      if (code !== 0) {
        failures.push(new Error(`ops exited ${code}: ${err}`));
      }
      try {
        ownerScript(flow, "release", { issue, execution });
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        reject(failures[0]);
        return;
      }
      resolve(JSON.parse(out));
    });
    child.stdin.end(`BEGIN_OPS_REQUEST\n${body}\nEND_OPS_REQUEST`);
  });
}

/**
 * The integration turn's records, in order, as the world keeps them.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @returns {any[]}
 */
function turnRecords(flow) {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(COORDINATION))
    .map(({ id, body }) => ({ id, ...JSON.parse(body.split("\n")[1] ?? "") }))
    .filter(({ scope }) => scope === TURN_SCOPE);
}

/**
 * The turn's open requests by issue, in order, and the issues whose
 * requests were released or cancelled; a summary for assertions, not the
 * protocol's own reading.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 */
function turnView(flow) {
  const rows = turnRecords(flow);
  const ended = new Set(
    rows
      .filter(({ kind }) => kind === "release" || kind === "cancel")
      .map(({ request }) => request),
  );
  const requests = rows.filter(({ kind }) => kind === "request");
  return {
    open: requests
      .filter(({ id }) => !ended.has(id))
      .map(({ identity }) => identity.issue),
    ended: requests
      .filter(({ id }) => ended.has(id))
      .map(({ identity }) => identity.issue),
  };
}

/** @param {string} dir @param {number} from @returns {string[][]} PR writes, approvals and merges since `from` */
function prWrites(dir, from) {
  return ghCalls(dir)
    .slice(from)
    .filter(
      (args) =>
        (args[0] === "pr" && !READ_ONLY_PR.has(String(args[1]))) ||
        args.some((arg) => arg.includes("/reviews") || arg.includes("/merges")),
    );
}

export { contenders, landing, prWrites, TURN_SCOPE, turnRecords, turnView };
