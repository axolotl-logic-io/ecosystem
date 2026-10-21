// @ts-check
// Verification once the issue's code merged (`state.codeMerged`), as the
// Reviewer runs it after the merge: verify runs the repo's checks on
// exactly the merge commit, and a failure there stops with check-fixes and
// no session. Developer entry after the merge stops for reconciliation
// before any operation, save or session.
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { z } from "zod";
import {
  BASE,
  fakeContext,
  HEAD,
  INPUTS,
  ISSUE,
  opNames,
  PR,
  ROOT,
  shaOf,
  TEMPORARY_ROOT,
} from "./implementor-test-kit.mjs";

// The config bound the callers pass in; its defaults fill it in.
const CI_LIMIT = z.looseObject({ maxCiFixes: z.number().int().nonnegative() });
const { implementorRole } = await import(
  "../src/roles/implementor/implementor.ts"
);
const { verifiedHead } = await import("../src/roles/verification.ts");

const MERGED = shaOf("f");
const CODE_MERGED = { pr: PR, sha: MERGED };
const VERIFIED = { pass: true, headSha: MERGED, checks: [] };
const CODE_FAILS = {
  pass: false,
  headSha: MERGED,
  checks: [{ id: "test", pass: false, detail: "exit 1" }],
};

const RECONCILE =
  /explicit reconciliation is required, not another Developer session/u;

/**
 * @param {Parameters<typeof fakeContext>[0]} [script]
 */
function mergedContext(script = {}) {
  return fakeContext({
    ...script,
    state: { codeMerged: CODE_MERGED, pr: PR, ...script.state },
    ops: { verify: [VERIFIED], ...script.ops },
  });
}

/**
 * The verified head of work after the merge, in the hardening phase.
 * @param {ReturnType<typeof mergedContext>} run
 */
function verified(run) {
  return verifiedHead(run.ctx, run.ctx.state, {
    mode: { kind: "merged", merged: CODE_MERGED },
    phase: "hardening",
    maxCiFixes: CI_LIMIT.parse(run.ctx.cfg).maxCiFixes,
  });
}

test("the tests run under a temporary pipeline root", () => {
  assert.equal(ROOT, TEMPORARY_ROOT);
  assert.ok(TEMPORARY_ROOT.startsWith(os.tmpdir()));
});

test("postmerge Developer entry requires reconciliation without changing retained work", async () => {
  const { ctx, ops, sessions, saves } = mergedContext({
    state: {
      branch: `agent/issue-${ISSUE}`,
      headSha: HEAD,
      hardened: { code: HEAD, inputs: INPUTS },
      log: ["2026-10-18T00:00Z code merged; reconciliation pending"],
    },
  });
  const original = structuredClone(ctx.state);
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, RECONCILE);
  assert.deepEqual(end.state, original);
  assert.deepEqual(ctx.state, original);
  assert.deepEqual(opNames(ops), []);
  assert.equal(sessions.length, 0);
  assert.deepEqual(saves, []);
  assert.deepEqual(end.state.codeMerged, CODE_MERGED);
  assert.equal(end.state.pr, PR);
});

test("verification after the merge checks exactly the merge commit", async () => {
  const run = mergedContext();
  const end = await verified(run);
  assert.deepEqual(opNames(run.ops), ["verify"]);
  assert.deepEqual(run.ops[0]?.payload, {
    number: ISSUE,
    codeMerged: CODE_MERGED,
  });
  assert.deepEqual(end, { ok: true, value: MERGED });
});

test("a verify of anything but the merge commit stops with error", async () => {
  const run = mergedContext({
    ops: { verify: [{ ...VERIFIED, headSha: BASE }] },
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "error");
  assert.match(
    end.end.reason,
    new RegExp(`checked ${BASE}, not the merge commit ${MERGED}`, "u"),
  );
  assert.equal(run.sessions.length, 0);
});

test("checks failing on the merged code stop check-fixes with no fix session, naming them", async () => {
  const run = mergedContext({
    ops: { verify: [CODE_FAILS] },
  });
  const end = await verified(run);
  assert.ok(!end.ok && end.end.kind === "stop");
  assert.equal(end.end.code, "check-fixes");
  assert.match(
    end.end.reason,
    new RegExp(
      `merged code at ${MERGED}, which work after the merge can't change: test`,
      "u",
    ),
  );
  assert.equal(run.sessions.length, 0);
  assert.equal(opNames(run.ops).filter((name) => name === "verify").length, 1);
});

test("a queued cannot reply cannot supersede postmerge Developer refusal", async () => {
  const { ctx, ops, sessions, saves } = mergedContext({
    sessions: [{ ok: true, reply: { outcome: "cannot", reason: "no page" } }],
    state: {
      security: {
        revision: { code: MERGED, inputs: INPUTS },
        commentId: PR,
        finding: { category: "abuse-risk", reason: "unsafe merged result" },
      },
      log: ["2026-10-18T00:00Z Security rejected the merged result"],
    },
  });
  const original = structuredClone(ctx.state);
  const end = await implementorRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "error");
  assert.match(end.reason, RECONCILE);
  assert.deepEqual(end.state, original);
  assert.deepEqual(ctx.state, original);
  assert.deepEqual(opNames(ops), []);
  assert.equal(sessions.length, 0);
  assert.deepEqual(saves, []);
});
