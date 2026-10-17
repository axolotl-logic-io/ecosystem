// The adoption of a push whose state save failed: a claim that finds the
// branch at a head the pipeline pushed itself, past the saved one, carries on
// from it instead of stopping with branch-changed.
import type { PushRecord } from "./checkouts.ts";
import type { State } from "./state.ts";

const STAMP_LENGTH = 16;
// How much of a head the log names.
const LOG_SHA_LENGTH = 8;

function stamp(now: Date): string {
  return `${now.toISOString().slice(0, STAMP_LENGTH)}Z`;
}

// The ops whose pushes are adopted: the syncs with the base branch, which push
// a head made from one the reviews already passed. Every other push (start-pr,
// open-pr, a fix's or a CI fix's push) is followed by a review that adoption
// would skip.
const ADOPTABLE_OPS: ReadonlySet<string> = new Set([
  "sync-base",
  "finish-sync",
]);

// The stages after review, from which an adopted head can go back to sync
// without skipping the code review.
const ADOPTABLE_STAGES: ReadonlySet<unknown> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);

// The ops a writer's stage job pushes with past its last state save: as it
// exits (src/job/exit-push.ts), of commits its checkout holds, such as those
// of an implementer session a stop interrupted (#315); and as its sessions
// commit through pipeline_commit (src/job/commit-push.ts, #303).
// Each names the push in the state's log.
const JOB_PUSHES: ReadonlyMap<string, string> = new Map([
  ["exit-push", "exit push"],
  ["pipeline-commit", "pipeline_commit push"],
]);

// The stages from which a job's push is adopted, keeping the stage: each
// reviews every commit past the last review before the code moves on (the
// review after open-pr, or a fix round's re-review of the diff since the last
// review). From a later stage it would skip that review, so it still stops.
const EXIT_PUSH_STAGES: ReadonlySet<unknown> = new Set([
  "implement",
  "open-pr",
  "fix",
]);

// The saved state with the branch head the pipeline pushed itself adopted, for
// when the push landed after the last state save: the saved head is set, and
// `remote` differs from it but is the head this machine recorded pushing
// (`pushed`). A sync's push, whose state save failed, from a state saved at
// sync or later, goes back through sync and every check after it. A job's
// exit or pipeline_commit push from a state saved at implement, open-pr or
// fix keeps the stage.
// Any other push would skip the review that follows it, so it still stops
// with branch-changed. Null when there is nothing to adopt.
function adoptPush(
  saved: State,
  remote: string | null,
  pushed: PushRecord | null,
  now: Date,
): State | null {
  const { headSha, stage } = saved;
  const known = headSha !== undefined && headSha !== null;
  if (!known || remote === null || remote === headSha || pushed === null) {
    return null;
  }
  if (remote !== pushed.sha) {
    return null;
  }
  const short = remote.slice(0, LOG_SHA_LENGTH);
  const jobPush = JOB_PUSHES.get(pushed.op);
  if (jobPush !== undefined && EXIT_PUSH_STAGES.has(stage)) {
    const entry = `${stamp(now)} adopted the stage job's ${jobPush} ${short} at ${String(stage)}`;
    return { ...saved, headSha: remote, log: [...(saved.log ?? []), entry] };
  }
  if (!(ADOPTABLE_OPS.has(pushed.op) && ADOPTABLE_STAGES.has(stage))) {
    return null;
  }
  const entry = `${stamp(now)} adopted the pipeline's own push ${short}; its state save had failed`;
  return {
    ...saved,
    headSha: remote,
    passedSha: null,
    stage: "sync",
    log: [...(saved.log ?? []), entry],
  };
}

export { adoptPush };
