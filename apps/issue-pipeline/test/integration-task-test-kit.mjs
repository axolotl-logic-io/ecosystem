// @ts-check
// Read-only Integration and exact Land's world (#185): the Sync world
// (sync-task-test-kit) with revision R already containing target T, results
// the landing account records for earlier tasks, and what the origin and
// GitHub show, so a test can prove an op made no forbidden effect.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ghCalls } from "./fake-pipeline-flow-gh.mjs";
import { now, withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { isCoordinationWrite } from "./pipeline-flow-coordination-test-kit.mjs";
import { bareGit } from "./pipeline-flow-test-kit.mjs";
import { gitIn, syncWorld } from "./sync-task-test-kit.mjs";
import {
  plantComment,
  rawOps,
  recordAttempt,
  recordResult,
  runId,
  stateText,
  v2State,
} from "./task-results-test-kit.mjs";

const ISSUE = 7;
const CHECK = z.looseObject({ id: z.string(), pass: z.boolean() });
const LAND_REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  merged: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  mergeCommit: z.string().optional(),
  headSha: z.string().optional(),
});
const INTEGRATION_REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  route: z
    .enum(["sync-needed", "hardening-needed", "hold", "developer", "security"])
    .optional(),
  reason: z.string().optional(),
  verdict: z.enum(["passed", "failed"]).optional(),
  checks: z.array(CHECK).optional(),
  retained: z.string().optional(),
});

/**
 * Issue 7 at revision R, which contains the target T it forked from, or
 * `issue` added to another issue's `flow`.
 * @param {{ file: string, bytes: string }} [mine]
 * @param {{ issue?: number, flow?: import("./pipeline-flow-test-kit.mjs").Flow | undefined }} [where]
 */
function integrationWorld(
  mine = { file: "feature.txt", bytes: "mine\n" },
  { issue = ISSUE, flow } = {},
) {
  const world = syncWorld(issue, mine, undefined, flow);
  /** R's binding for `task` on T. @param {string} task */
  function bound(task) {
    return { ...world.binding(world.start), task };
  }
  /** Records a passed result for `task`, as the landing account does. @param {string} task */
  function passed(task) {
    const run = runId();
    recordAttempt(world.flow, issue, bound(task), { id: run, previous: null });
    recordResult(world.flow, issue, bound(task), {
      run,
      verdict: "passed",
      summary: `${task} passed on R`,
    });
  }
  /** One integration-task request. @param {object} [binding] */
  function integrate(binding = bound("Integration")) {
    return INTEGRATION_REPLY.parse(
      rawOps(world.flow, {
        op: "integration-task",
        number: issue,
        binding,
        run: { id: runId(), previous: null },
      }),
    );
  }
  /** Opens the issue's PR and saves the state an installed merge checks. */
  function readyToLand() {
    const pr = withWorld(world.flow.ghDir, (gh) => {
      const number = gh.nextId;
      gh.nextId += 1;
      gh.prs.push({
        number,
        head: world.branch,
        base: "integration",
        title: `Issue ${issue}`,
        body: "",
        state: "OPEN",
        isDraft: false,
        mergeOid: null,
        mergedHead: null,
      });
      gh.issues.push({
        number,
        title: `Issue ${issue}`,
        body: "",
        login: "dev-bot",
        state: "open",
        createdAt: now(),
        stateReason: null,
        labels: [],
        isPull: true,
      });
      return number;
    });
    const { revision } = bound("Land");
    const target = { repo: "o/r", branch: "integration", sha: world.start };
    const state = v2State(issue, {
      stage: "merge",
      branch: world.branch,
      pr,
      headSha: world.revision,
      hardened: revision,
      hardenedTarget: target,
      verifiedSha: world.revision,
      security: {
        phase: "candidate",
        revision,
        target,
        commentId: 1,
        finding: null,
      },
    });
    plantComment(world.flow.ghDir, issue, "bot", stateText(state));
    return { pr, state, revision };
  }
  /** One merge request for R onto T, with `extra` fields. @param {ReturnType<typeof readyToLand>} ready @param {object} extra */
  function land(ready, extra) {
    return LAND_REPLY.parse(
      rawOps(world.flow, {
        op: "merge",
        number: issue,
        state: ready.state,
        expectedSha: world.revision,
        expectedBase: world.start,
        revision: ready.revision,
        mergeQueue: [ready.pr],
        summary: "Exact Land of R on T.",
        ...extra,
      }),
    );
  }
  /** One confirm-merged request. @param {{ pr: number, sha: string }} codeMerged @param {object} [binding] */
  function confirm(codeMerged, binding) {
    return LAND_REPLY.parse(
      rawOps(world.flow, {
        op: "confirm-merged",
        number: issue,
        codeMerged,
        binding,
      }),
    );
  }
  return { ...world, bound, passed, integrate, readyToLand, land, confirm };
}

/** @param {string} origin @returns {string} every ref on the origin */
function originRefs(origin) {
  return bareGit(origin, ["show-ref"]);
}

/** What the issue's own checkout holds: its head, index and tracked files. @param {string} wt */
function checkoutOf(wt) {
  return {
    head: gitIn(wt, ["rev-parse", "HEAD"]),
    status: gitIn(wt, ["status", "--porcelain"]),
  };
}

/** gh calls after `from` that wrote to a PR, or wrote anything but a comment. @param {string} dir @param {number} from */
function forbiddenGhWrites(dir, from) {
  return ghCalls(dir)
    .slice(from)
    .filter((args) => !isCoordinationWrite(args))
    .filter(
      (args) =>
        args[0] === "pr" ||
        (args.includes("-X") &&
          !args.some((arg) => arg.endsWith(`/issues/${ISSUE}/comments`))),
    );
}

/** @param {string} retained @returns {string} the retained patch */
function retainedPatch(retained) {
  return fs.readFileSync(path.join(retained, "tracked.patch"), "utf8");
}

export {
  checkoutOf,
  forbiddenGhWrites,
  ISSUE,
  integrationWorld,
  originRefs,
  retainedPatch,
};
