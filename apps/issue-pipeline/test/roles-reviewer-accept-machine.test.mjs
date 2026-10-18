// @ts-check
// The reviewer machine's `accept` entry (#423; the wiki's
// Pipeline-Roles-Reviewer, "Entry `accept`"): locate on a state today's
// `accept` stage saved, and every edge's next state and effect, from the
// checkout through prepare-accept, accept-work?, the verifier and its
// verdict to the end each one takes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { checkTable } from "../src/roles/machine.ts";
import { roleOf } from "../src/roles/registry.ts";
import {
  LIMITS,
  REVIEWER_STAGES,
  reviewerMachine,
  TABLE,
} from "../src/roles/reviewer/machine.ts";
import { ACCEPT_SCHEMA } from "../src/workflow/schemas.ts";
import {
  acceptLocated,
  acceptStep,
  FAIL,
  FINAL,
  FINAL_DIFF,
  FINAL_PATCH_ID,
  finalData,
  KEPT_TEXT,
  NEXT_FINDING_ID,
  PASS,
  PASSED,
  PASSED_PATCH_ID,
  VERIFIED,
  VERIFY_SUMMARY,
} from "./reviewer-accept-test-kit.mjs";
import { RESOLVED, seen } from "./reviewer-role-test-kit.mjs";
import { roleContext } from "./role-context-fixtures.mjs";

/** @import { AfterOp, Effect } from "../src/roles/machine.ts" */
/** @import { ReviewerData } from "../src/roles/reviewer/locate.ts" */

const ENTRY = new URL(
  "../src/roles/reviewer/entries/accept.ts",
  import.meta.url,
).pathname;
const NETWORK = "Could not resolve host: api.github.com";

/**
 * The end an end state's effect carries.
 * @param {Effect} effect
 * @returns {{ kind: string, code?: string, stage?: string, after?: AfterOp }}
 */
function endOf(effect) {
  const { kind, end } = seen(effect);
  if (kind !== "end" || end === undefined) {
    throw new Error(`${kind} isn't an end`);
  }
  return end;
}

/**
 * The end an effect carries, as an error stop's code, op, reason and detail.
 * @param {Effect} effect
 * @returns {{ kind: string, code: string | undefined, op: string | undefined, reason: unknown, detail: unknown }}
 */
function stopOf(effect) {
  const { kind, code, after } = endOf(effect);
  const { reason, detail } = after?.payload ?? {};
  return { kind, code, op: after?.op, reason, detail };
}

/**
 * The error stop for `reason`, with `detail`, as stopOf reads it.
 * @param {string} reason
 * @param {string | null} detail
 */
function errorStop(reason, detail) {
  return { kind: "stopped", code: "error", op: "stop", reason, detail };
}

/** @param {ReviewerData} data @param {string} text @returns {boolean} whether its log notes `text` */
function logs(data, text) {
  return (data.log ?? []).some((line) => line.includes(text));
}

test("locate resumes a state today's accept stage saved at claim, in the accept entry", () => {
  const { at, data } = acceptLocated();
  assert.equal(at, "claim");
  assert.equal(data.entry, "accept");
  assert.equal(data.verifiedSha, VERIFIED);
  assert.equal(data.verifySummary, VERIFY_SUMMARY);
  assert.equal(data.acceptedSha, PASSED);
  assert.equal(data.acceptedPatchId, PASSED_PATCH_ID);
  assert.equal(data.nextFindingId, NEXT_FINDING_ID);
  assert.deepEqual(data.findings, [RESOLVED]);
  assert.equal(acceptStep("claim", "ok").state.at, "checkout");
});

test("the checkout enters the accept entry at prepare-accept, and review at prepare", () => {
  const accept = acceptStep("checkout", "accept");
  assert.equal(accept.state.at, "prepare-accept");
  assert.equal(seen(accept.effect).check, "prepare-accept");
  assert.equal(acceptStep("checkout", "review").state.at, "prepare");
});

test("prepare-accept goes on to accept-work?, stops on a moved branch or a failed prep, and defers on the network", () => {
  const prepared = acceptStep("prepare-accept", "ok", FINAL);
  assert.equal(prepared.state.at, "accept-work?");
  assert.equal(seen(prepared.effect).check, "accept-work?");
  assert.equal(prepared.state.data.patchId, FINAL_PATCH_ID);
  assert.deepEqual(
    stopOf(acceptStep("prepare-accept", "moved").effect),
    errorStop("the branch changed after verification", null),
  );
  const failed = acceptStep("prepare-accept", "failed", "no merge base");
  assert.deepEqual(
    stopOf(failed.effect),
    errorStop("could not prepare the final diff", "no merge base"),
  );
  const deferred = acceptStep("prepare-accept", "deferred", NETWORK);
  assert.deepEqual(endOf(deferred.effect), { kind: "held" });
  assert.ok(logs(deferred.state.data, "deferred: network error"));
});

test("an unchanged patch id keeps the verdict, saving at security with the kept note; a changed one runs the verifier", () => {
  const kept = acceptStep("accept-work?", "kept", null, finalData());
  assert.deepEqual(endOf(kept.effect), { kind: "saved", stage: "security" });
  assert.ok(logs(kept.state.data, KEPT_TEXT), "logs the kept verdict");
  assert.equal(kept.state.data.acceptedSha, PASSED);
  const run = acceptStep("accept-work?", "run", null, finalData());
  assert.equal(run.state.at, "verifier");
  const session = seen(run.effect);
  assert.equal(session.kind, "session");
  assert.equal(session.name, "accept");
  assert.equal(session.agent, "issue-pipeline-reader");
  assert.equal(session.model, roleContext().models.verifier);
  assert.deepEqual(session.schema, ACCEPT_SCHEMA);
  const task = session.task ?? "";
  assert.ok(task.includes("acceptance verifier"), "the verifier's role");
  assert.ok(task.includes(FINAL_DIFF), "reads the final diff");
  assert.ok(task.includes(VERIFY_SUMMARY), "names the checks' summary");
  assert.ok(task.includes("src/a.ts does the thing"), "shows the spec");
});

test("the verifier's reply goes to post-verdict, and its failure stops: the acceptance verifier failed", () => {
  const replied = acceptStep("verifier", "replied", PASS, finalData());
  assert.equal(replied.state.at, "post-verdict");
  assert.equal(seen(replied.effect).check, "post-verdict");
  const failed = acceptStep("verifier", "failed", "pi exited 1", finalData());
  assert.deepEqual(
    stopOf(failed.effect),
    errorStop("the acceptance verifier failed", "pi exited 1"),
  );
});

test("a pass saves at security, recording the verified head, its patch id and the reason", () => {
  const passed = acceptStep("post-verdict", "pass", PASS, finalData());
  assert.deepEqual(endOf(passed.effect), { kind: "saved", stage: "security" });
  const { data } = passed.state;
  assert.equal(data.acceptedSha, VERIFIED);
  assert.equal(data.acceptedPatchId, FINAL_PATCH_ID);
  assert.equal(data.acceptReason, PASS.reason);
  assert.ok(logs(data, `acceptance: pass - ${PASS.reason}`));
});

test("a fail saves at fix with an open acceptance finding, clearing the accepted head and patch id", () => {
  const failed = acceptStep("post-verdict", "fail", FAIL, finalData());
  assert.deepEqual(endOf(failed.effect), { kind: "saved", stage: "fix" });
  const { data } = failed.state;
  assert.equal(data.acceptedSha, null);
  assert.equal(data.acceptedPatchId, null);
  assert.equal(data.reviewedSha, VERIFIED);
  assert.equal(data.nextFindingId, NEXT_FINDING_ID + 1);
  const [resolved, added] = data.findings;
  assert.deepEqual(resolved, RESOLVED);
  assert.equal(added?.id, `f${NEXT_FINDING_ID + 1}`);
  assert.equal(added?.status, "open");
  assert.deepEqual(added?.lenses, ["acceptance"]);
  assert.equal(added?.evidence, FAIL.reason);
  assert.ok(logs(data, `acceptance: fail - ${FAIL.reason}`));
});

test("an unreadable verdict stops: the acceptance verifier failed", () => {
  const unreadable = acceptStep("post-verdict", "unreadable", null);
  assert.deepEqual(
    stopOf(unreadable.effect),
    errorStop("the acceptance verifier failed", null),
  );
});

test("the table stays clean with the accept entry, which hands off the acceptance fields", () => {
  assert.deepEqual(checkTable(TABLE, LIMITS, finalData()), []);
  for (const field of ["acceptedSha", "acceptedPatchId", "acceptReason"]) {
    assert.ok(
      reviewerMachine.handoff.some((name) => name === field),
      `hands off ${field}`,
    );
  }
});

test("the reviewer runs accept stage jobs too; security keeps its stage code", () => {
  assert.ok(fs.existsSync(ENTRY), "the accept entry has its own module");
  assert.deepEqual(REVIEWER_STAGES, ["review", "accept"]);
  assert.equal(roleOf("accept")?.name, "reviewer");
  assert.equal(roleOf("accept")?.kind, "machine");
  assert.equal(roleOf("security"), undefined);
});
