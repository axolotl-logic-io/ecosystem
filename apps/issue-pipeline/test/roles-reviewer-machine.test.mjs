// @ts-check
// The reviewer machine's `review` entry (#421; the wiki's
// Pipeline-Roles-Reviewer, "Entry `review`"): every edge's next state and
// effect, a clean table, the lenses as one sessions effect on their models
// with the shared prefix, locate on a state today's stage saved, the stage
// it is registered for, its layout and its isolation from the other roles.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkTable } from "../src/roles/machine.ts";
import { roleOf } from "../src/roles/registry.ts";
import {
  LIMITS,
  reviewerMachine,
  TABLE,
} from "../src/roles/reviewer/machine.ts";
import { AGG_SCHEMA, REVIEW_SCHEMA } from "../src/workflow/review-schemas.ts";
import {
  BUNDLE_TEXT,
  HEAD,
  located,
  OLD_REVIEW_STATE,
  PATCH_ID,
  PR,
  PREPARED,
  preparedData,
  RESOLVED,
  seen,
  stepFrom,
} from "./reviewer-role-test-kit.mjs";
import { roleContext } from "./role-context-fixtures.mjs";

const ROLES = new URL("../src/roles/", import.meta.url).pathname;
const IMPORT_FROM = /from\s+"(?<target>[^"]+)"/gu;
// The next finding number once the store numbered one.
const STORED_NEXT = 3;
const NO_MERGE_BASE = /no merge base/u;
const LENS_ORDER = ["correctness", "tests", "scope"];
const RAW = [{ lens: "tests", ...RESOLVED, severity: "blocking" }];

/** @import { AfterOp, Effect } from "../src/roles/machine.ts" */

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

/** @param {{ after?: AfterOp }} end @returns {{ reason?: unknown, detail?: unknown }} its stop's reason and detail */
function stopOf(end) {
  const { reason, detail } = end.after?.payload ?? {};
  return { reason, detail };
}

test("locate resumes a state today's review stage saved at claim, keeping its review fields", () => {
  const { at, data } = located();
  assert.equal(at, "claim");
  assert.equal(data.issue, roleContext().issue);
  assert.equal(data.pr, PR);
  const { reviewedSha, reviewedPatchId, nextFindingId } = OLD_REVIEW_STATE;
  assert.equal(data.reviewedSha, reviewedSha);
  assert.equal(data.reviewedPatchId, reviewedPatchId);
  assert.equal(data.nextFindingId, nextFindingId);
  assert.deepEqual(data.findings, [RESOLVED]);
});

test("claim, checkout and prepare route as the Lifecycle table says", () => {
  assert.equal(stepFrom("claim", "ok").state.at, "checkout");
  assert.equal(seen(stepFrom("claim", "ok").effect).check, "checkout");
  assert.equal(endOf(stepFrom("claim", "not-ours").effect).kind, "released");
  assert.equal(seen(stepFrom("checkout", "ok").effect).check, "prepare");
  const empty = endOf(stepFrom("prepare", "empty").effect);
  assert.equal(empty.kind, "stopped");
  assert.equal(empty.after?.op, "stop");
  assert.equal(stopOf(empty).reason, "nothing to review");
  const failed = endOf(stepFrom("prepare", "failed", "no merge base").effect);
  assert.equal(failed.code, "error");
  assert.match(String(stopOf(failed).detail), NO_MERGE_BASE);
});

test("a prepared review runs the three lenses as one sessions effect, each on its model over the bundle", () => {
  const step = stepFrom("prepare", "ok", PREPARED);
  assert.equal(step.state.at, "lenses");
  const { kind, sessions } = seen(step.effect);
  assert.equal(kind, "sessions");
  const list = sessions ?? [];
  const { models } = roleContext();
  assert.deepEqual(
    list.map(({ name }) => name),
    LENS_ORDER.map((lens) => `review-${lens}`),
  );
  for (const [index, lens] of LENS_ORDER.entries()) {
    const session = list[index];
    assert.equal(session?.model, Reflect.get(models, lens));
    assert.equal(session?.agent, "issue-pipeline-reader");
    assert.deepEqual(session?.schema, REVIEW_SCHEMA);
    assert.ok(session?.task.includes(BUNDLE_TEXT), `${lens} reads the bundle`);
    assert.ok(session?.task.includes(`reviewer (${lens})`));
  }
});

test("the posted lenses route to a clean save at checks, the aggregator or a stop", () => {
  const data = preparedData();
  const replied = [{ name: "review-tests", outcome: { ok: true, reply: {} } }];
  const posting = stepFrom("lenses", "replied", replied, data);
  assert.equal(posting.state.at, "post-lenses");
  assert.equal(seen(posting.effect).check, "post-lenses");
  const clean = stepFrom("post-lenses", "clean", null, data);
  assert.deepEqual(endOf(clean.effect), { kind: "saved", stage: "checks" });
  assert.equal(clean.state.data.reviewedSha, HEAD);
  assert.equal(clean.state.data.reviewedPatchId, PATCH_ID);
  assert.equal(clean.state.data.testsOnly, false);
  const blocking = stepFrom("post-lenses", "blocking", RAW, data);
  assert.equal(blocking.state.at, "aggregate");
  assert.equal(blocking.state.data.reviewedSha, HEAD);
  const aggregate = seen(blocking.effect);
  assert.equal(aggregate.kind, "session");
  assert.equal(aggregate.model, roleContext().models.aggregator);
  assert.deepEqual(aggregate.schema, AGG_SCHEMA);
  const detail = "tests reviewer failed: no output";
  const stop = endOf(stepFrom("post-lenses", "lens-failed", detail).effect);
  assert.equal(stop.code, "error");
  assert.deepEqual(stopOf(stop), { reason: "a reviewer failed", detail });
});

test("the aggregator's reply or failure stores the findings, which save at fix", () => {
  const data = preparedData();
  const merged = { blocking: [] };
  for (const step of [
    stepFrom("aggregate", "replied", merged, data),
    stepFrom("aggregate", "failed", "the session failed", data),
  ]) {
    assert.equal(step.state.at, "store-findings");
    assert.equal(seen(step.effect).check, "store-findings");
  }
  const stored = { findings: [RESOLVED], nextFindingId: STORED_NEXT };
  const saved = stepFrom("store-findings", "ok", stored, data);
  assert.deepEqual(endOf(saved.effect), { kind: "saved", stage: "fix" });
  assert.equal(saved.state.data.nextFindingId, STORED_NEXT);
});

test("the table is clean, enters at claim and hands off the review fields", () => {
  const sample = preparedData();
  assert.deepEqual(checkTable(TABLE, LIMITS, sample), []);
  assert.deepEqual(TABLE.entries, ["claim"]);
  for (const field of [
    "headSha",
    "findings",
    "nextFindingId",
    "round",
    "reviewedSha",
    "reviewedPatchId",
    "testsOnly",
    "log",
  ]) {
    assert.ok(
      reviewerMachine.handoff.some((name) => name === field),
      `hands off ${field}`,
    );
  }
});

test("the reviewer runs review stage jobs; accept and security keep their stage code", () => {
  assert.equal(roleOf("review")?.name, "reviewer");
  assert.equal(roleOf("review")?.kind, "machine");
  assert.equal(roleOf("accept"), undefined);
  assert.equal(roleOf("security"), undefined);
});

/** @param {string} dir @returns {string[]} the .ts files under `dir` */
function sources(dir) {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(dir, file));
}

test("each entry has its own module, and the reviewer imports no other role's modules", () => {
  const own = path.join(ROLES, "reviewer");
  assert.ok(fs.existsSync(path.join(own, "entries", "review.ts")));
  for (const file of sources(own)) {
    const text = fs.readFileSync(file, "utf8");
    for (const { groups } of text.matchAll(IMPORT_FROM)) {
      const { target: imported = "" } = groups ?? {};
      const target = path.resolve(path.dirname(file), imported);
      const role = path.relative(ROLES, target).split(path.sep);
      const [first = "", second] = role;
      const foreign =
        second !== undefined && first !== "reviewer" && first !== "..";
      assert.ok(!foreign, `${file} imports ${target}`);
    }
  }
});
