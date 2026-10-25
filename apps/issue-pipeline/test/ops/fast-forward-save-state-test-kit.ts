// A lost native push acknowledgement, then a current-policy result observation.
import fs from "node:fs";
import path from "node:path";
import type { RoleContext, SessionResult } from "../../src/job/role-context.ts";
import type { MergeReply } from "../../src/ops/merge.ts";
import type { ReviewedTarget } from "../../src/reviewed-target.ts";
import type { IssueState, Revision, Security } from "../../src/state.ts";
import {
  consumed,
  post,
  prechecks,
  request,
  script,
} from "../explicit-target-test-kit.ts";
import type { World } from "../explicit-target-world-test-kit.ts";
import {
  ISSUE,
  ISSUE_DATA,
  PR,
  world,
} from "../explicit-target-world-test-kit.ts";
import { confirmationClock } from "./confirmation-clock-test-kit.ts";
import {
  confirmation,
  mergeComment,
} from "./explicit-target-recovery-test-kit.ts";

const { loadConfig }: typeof import("../../src/config.ts") = await import(
  "../../src/config.ts"
);
const { merge }: typeof import("../../src/ops/merge.ts") = await import(
  "../../src/ops/merge.ts"
);
const { readWriteState }: typeof import("../../src/saved-state.ts") =
  await import("../../src/saved-state.ts");
const { saveState }: typeof import("../../src/ops/save-state.ts") =
  await import("../../src/ops/save-state.ts");
const { policyRevision }: typeof import("../../src/project-policy.ts") =
  await import("../../src/project-policy.ts");
const { resultReviewTarget }: typeof import("../../src/security-clearance.ts") =
  await import("../../src/security-clearance.ts");
const { recorded }: typeof import("../../src/roles/merge/security-record.ts") =
  await import("../../src/roles/merge/security-record.ts");
const RESULT_TIMEOUT_MINUTES = 123;

function resultContext(w: World, state: IssueState): RoleContext {
  return {
    cfg: w.cfg,
    issue: ISSUE,
    stage: "merge",
    state,
    dirs: { job: w.place, repo: w.wt },
    issueFile: path.join(w.place, "issue.md"),
    inputs: {
      issue: ISSUE_DATA,
      comments: [],
      revision: w.revision.inputs,
      gherkin: null,
    },
    mergeQueue: null,
    op(): Promise<unknown> {
      return Promise.reject(new Error("unexpected result observation op"));
    },
    session(): Promise<SessionResult> {
      return Promise.reject(new Error("unexpected result observation session"));
    },
    post(): Promise<number> {
      return Promise.resolve(PR);
    },
    save(saved: IssueState): Promise<void> {
      saveState(w.cfg, { number: ISSUE, state: saved });
      return Promise.resolve();
    },
  };
}

// The result security the current-policy review records.
interface ResultSecurity {
  revision: Revision;
  target: ReviewedTarget;
  commentId: number;
  finding: Security["finding"];
}

// What a confirmed lost response and its result review leave behind.
interface LostResponse {
  w: World;
  confirmed: IssueState;
  resultSecurity: ResultSecurity;
  reviewed: IssueState;
  review: Awaited<ReturnType<typeof recorded>>;
  reply: MergeReply;
}

async function confirmedLostResponse(
  finding: Security["finding"],
): Promise<LostResponse> {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w, { code: 1, stderr: "acknowledgement lost after receive-pack" }),
    ...confirmation(w),
    mergeComment(w),
  ]);
  const reply = merge(w.cfg, request(w), confirmationClock());
  const confirmed = readWriteState(w.cfg, ISSUE);
  const file = path.join(w.place, "config.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...original,
      commandTimeoutMinutes: RESULT_TIMEOUT_MINUTES,
    }),
  );
  w.cfg = { ...loadConfig(file), slug: w.cfg.slug };
  const revision = { ...w.revision, ...policyRevision(w.cfg) };
  const target = resultReviewTarget(confirmed, revision);
  if (target === null) {
    throw new Error("missing own-merge result review target");
  }
  const resultSecurity: ResultSecurity = {
    revision,
    target,
    commentId: PR,
    finding,
  };
  const review = await recorded(resultContext(w, confirmed), confirmed, {
    revision,
    resultTarget: target,
    reply: { summary: "Current-policy result review", security: finding },
  });
  const reviewed = readWriteState(w.cfg, ISSUE);
  consumed();
  return { w, confirmed, resultSecurity, reviewed, review, reply };
}

export { confirmedLostResponse };
