// Read-only Integration and exact Land's world (#185): the Sync world
// (sync-task-test-kit) with revision R already containing target T, results
// the landing account records for earlier tasks, and what the origin and
// GitHub show, so a test can prove an op made no forbidden effect.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import { now, withWorld } from "./fake-pipeline-flow-gh-world.ts";
import { isCoordinationWrite } from "./pipeline-flow-coordination-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { bareGit } from "./pipeline-flow-test-kit.ts";
import type { SyncWorld, TaskBinding } from "./sync-task-test-kit.ts";
import { gitIn, syncWorld } from "./sync-task-test-kit.ts";
import {
  plantComment,
  rawOps,
  recordAttempt,
  recordResult,
  runId,
  stateText,
  v2State,
} from "./task-results-test-kit.ts";

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

type LandReply = z.infer<typeof LAND_REPLY>;
type IntegrationReply = z.infer<typeof INTEGRATION_REPLY>;

// The issue's open PR and the state an installed merge checks, at R.
interface ReadyToLand {
  pr: number;
  state: Record<string, unknown>;
  revision: { code: string; inputs: string; policy: string };
}

// The Sync world with the Integration and Land ops a test runs in it.
interface IntegrationWorld extends SyncWorld {
  bound: (task: string) => TaskBinding;
  passed: (task: string) => void;
  integrate: (binding?: object) => IntegrationReply;
  readyToLand: () => ReadyToLand;
  land: (ready: ReadyToLand, extra: object) => LandReply;
  confirm: (
    codeMerged: { pr: number; sha: string },
    binding: object,
  ) => LandReply;
}

// Issue 7 at revision R, which contains the target T it forked from, or
// `issue` added to another issue's `flow`.
function integrationWorld(
  mine: { file: string; bytes: string } = {
    file: "feature.txt",
    bytes: "mine\n",
  },
  { issue = ISSUE, flow }: { issue?: number; flow?: Flow | undefined } = {},
): IntegrationWorld {
  const world = syncWorld(issue, mine, undefined, flow);
  //  R's binding for `task` on T.
  function bound(task: string): TaskBinding {
    return { ...world.binding(world.start), task };
  }
  //  Records a passed result for `task`, as the landing account does.
  function passed(task: string): void {
    const run = runId();
    recordAttempt(world.flow, issue, bound(task), { id: run, previous: null });
    recordResult(world.flow, issue, bound(task), {
      run,
      verdict: "passed",
      summary: `${task} passed on R`,
    });
  }
  //  One integration-task request.
  function integrate(binding: object = bound("Integration")): IntegrationReply {
    return INTEGRATION_REPLY.parse(
      rawOps(world.flow, {
        op: "integration-task",
        number: issue,
        binding,
        run: { id: runId(), previous: null },
      }),
    );
  }
  //  Opens the issue's PR and saves the state an installed merge checks.
  function readyToLand(): ReadyToLand {
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
  //  One merge request for R onto T, with `extra` fields.
  function land(ready: ReadyToLand, extra: object): LandReply {
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
  //  One confirm-merged request.
  function confirm(
    codeMerged: { pr: number; sha: string },
    binding: object,
  ): LandReply {
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

// Returns every ref on the origin
function originRefs(origin: string): string {
  return bareGit(origin, ["show-ref"]);
}

//  What the issue's own checkout holds: its head, index and tracked files.
function checkoutOf(wt: string): { head: string; status: string } {
  return {
    head: gitIn(wt, ["rev-parse", "HEAD"]),
    status: gitIn(wt, ["status", "--porcelain"]),
  };
}

//  gh calls after `from` that wrote to a PR, or wrote anything but a comment.
function forbiddenGhWrites(dir: string, from: number): string[][] {
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

// Returns the retained patch
function retainedPatch(retained: string): string {
  return fs.readFileSync(path.join(retained, "tracked.patch"), "utf8");
}

export type { IntegrationReply, IntegrationWorld, LandReply, ReadyToLand };
export {
  checkoutOf,
  forbiddenGhWrites,
  ISSUE,
  integrationWorld,
  originRefs,
  retainedPatch,
};
