// Scenario steps shared by the real-flow own-merge replay and closed-race
// recovery tests: the replay's setup stages, rewinding the cleared own FF
// merge to its saved receipt, and an installed-caller recovery that must be
// refused.
import { isStateBody } from "../src/comment-marks.ts";
import type { Integration, Revision } from "../src/state.ts";
import { ghCalls } from "./fake-pipeline-flow-gh.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import {
  readWorld,
  withWorld,
  writeWorld,
} from "./fake-pipeline-flow-gh-world.ts";
import {
  isCoordinationWrite,
  withoutCoordination,
} from "./pipeline-flow-coordination-test-kit.ts";
import { opsTrace } from "./pipeline-flow-ops-test-kit.ts";
import { replaceState, sessions } from "./pipeline-flow-replay-test-kit.ts";
import type { JobResult } from "./pipeline-flow-run-test-kit.ts";
import {
  runCallerStage,
  runStage,
  runThroughTasks,
} from "./pipeline-flow-run-test-kit.ts";
import { savedState } from "./pipeline-flow-script-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, ISSUE, refIn } from "./pipeline-flow-test-kit.ts";

const MUTATION_ARGS = new Set([
  "POST",
  "PATCH",
  "DELETE",
  "reopen",
  "close",
  "edit",
  "create",
]);

// The replay's setup stages before its interrupted merge: the first
// hardened head fails CI, so merge (after the Integration it requests, which
// the setup relays) returns it to Hardening, which fixes it.
const REPLAY_SETUP = [
  { stage: "author", end: "next", action: "none" },
  { stage: "implement", end: "next", action: "none" },
  { stage: "review", end: "next", action: "fail-ci" },
  { stage: "merge", end: "next", action: "relay" },
  { stage: "review", end: "next", action: "integration" },
];

// Runs one setup stage. The fixture's pre-activation integration receipt is
// built from the two real hardened revisions (pipeline-flow-replay-test-kit
// historicalMerge): the one whose CI failed and the one Hardening fixed.
function completeSetupStage(
  flow: Flow,
  { stage, action }: { stage: string; action: string },
  setup: { integration?: Integration; reviewed?: Revision },
): string {
  let end = "";
  if (action === "relay") {
    end = runThroughTasks(flow, stage).at(-1)?.end ?? "";
  } else {
    ({ end } = runStage(flow, stage));
  }
  if (action === "fail-ci") {
    withWorld(flow.ghDir, (world) => {
      const { hardened } = savedState(world);
      if (hardened === null) {
        throw new Error(`${stage} saved no hardening`);
      }
      setup.reviewed = hardened;
      world.failedHead = hardened.code;
    });
  }
  if (action === "integration" && setup.reviewed !== undefined) {
    const { hardened } = savedState(readWorld(flow.ghDir));
    if (hardened === null) {
      throw new Error(`${stage} saved no hardening`);
    }
    setup.integration = { reviewed: setup.reviewed, revision: hardened };
  }
  return end;
}

// The genuine cleared own merge rewound to its saved receipt at Merge,
// before completion, with `extra` state.
function restoreClearedReceipt(
  flow: Flow,
  clearedWorld: World,
  extra: Record<string, unknown> = {},
): void {
  writeWorld(flow.ghDir, structuredClone(clearedWorld));
  replaceState(flow, {
    ...savedState(clearedWorld),
    stage: "merge",
    ...extra,
  });
}

// What a recovery could see or change: the fake GitHub without its
// coordination, the target's and the branch's heads, and the pi sessions.
interface RecoverySnapshot {
  world: Omit<World, "refs" | "nextId">;
  head: string | null;
  branch: string | null;
  sessions: number;
}

// A refused recovery: the caller's result, the snapshots before and after
// it, the ops it ran and the GitHub writes it made.
interface RefusedRecovery {
  result: JobResult;
  before: RecoverySnapshot;
  after: RecoverySnapshot;
  ops: string[];
  writes: string[][];
}

function recoverySnapshot(flow: Flow): RecoverySnapshot {
  return {
    world: withoutCoordination(readWorld(flow.ghDir)),
    head: refIn(flow.origin, `refs/heads/${BASE}`),
    branch: refIn(flow.origin, `refs/heads/agent/issue-${ISSUE}`),
    sessions: sessions(flow),
  };
}

// The installed caller's merge on `interruptedWorld` with `extra` state, or
// none: its result, what it saw and changed, its ops and GitHub writes.
async function refusedRecovery(
  flow: Flow,
  interruptedWorld: World,
  extra: Record<string, unknown> | null,
): Promise<RefusedRecovery> {
  writeWorld(flow.ghDir, structuredClone(interruptedWorld));
  withWorld(flow.ghDir, (world) => {
    world.withholdMergeBinding = false;
    if (extra === null) {
      world.comments = world.comments.filter(({ body }) => !isStateBody(body));
    }
  });
  if (extra !== null) {
    replaceState(flow, { ...savedState(interruptedWorld), ...extra });
  }
  const before = recoverySnapshot(flow);
  const beforeCalls = ghCalls(flow.ghDir).length;
  const beforeTrace = opsTrace(flow).length;
  const result = await runCallerStage(flow, "merge");
  return {
    result,
    before,
    after: recoverySnapshot(flow),
    ops: opsTrace(flow)
      .slice(beforeTrace)
      .map(({ request }) => request.op),
    writes: ghCalls(flow.ghDir)
      .slice(beforeCalls)
      .filter((args) => args.some((arg) => MUTATION_ARGS.has(arg)))
      // The job's own request and confirmation precede its claim (#167).
      .filter((args) => !isCoordinationWrite(args)),
  };
}

export type { RecoverySnapshot, RefusedRecovery };
export {
  completeSetupStage,
  REPLAY_SETUP,
  refusedRecovery,
  restoreClearedReceipt,
};
