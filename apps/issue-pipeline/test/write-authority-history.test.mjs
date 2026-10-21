// @ts-check
// Null saved PRs are not evidence that an actual PR never existed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headOf, ISSUE, openJob } from "./pipeline-commit-test-kit.mjs";
import {
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "./write-authority-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { saveDraftAuthority } = await import("../src/ops/pr-state.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const PR = 42;
const TITLE_LENGTH = 45;

for (const status of ["OPEN", "MERGED", "CLOSED"]) {
  test(`all-state discovery validates actual ${status} identity with saved pr:null`, async () => {
    const job = await openJob("implement");
    try {
      const original = headOf(job.repo);
      savePrHistory(job.cfg, [{ number: PR }]);
      let mergeCommit = null;
      if (status === "MERGED") {
        mergeCommit = { oid: original };
      }
      savePrAuthority(job.cfg, {
        number: PR,
        state: status,
        headRefName: job.branch,
        headRefOid: original,
        baseRefName: job.cfg.baseBranch,
        isCrossRepository: false,
        mergeCommit,
      });
      let result = "refused";
      try {
        result = String(readWriteAuthority(job.cfg, ISSUE).codeWritable);
      } catch {
        // Refused CLOSED authority remains an explicit outcome, never writable.
      }
      const expected = new Map([
        ["OPEN", "true"],
        ["MERGED", "false"],
        ["CLOSED", "refused"],
      ]);
      assert.equal(result, expected.get(status));
      // Discovery cannot forge an own-merge/approval or silently save a receipt.
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
      assert.equal(readWriteState(job.cfg, ISSUE).codeMerged, null);
    } finally {
      job.close();
    }
  });
}

for (const bad of [
  null,
  {},
  [{ number: "42" }],
  [{ number: PR }, { number: PR + 1 }],
  Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
]) {
  test(`malformed, unreadable, ambiguous or saturated PR history refuses: ${JSON.stringify(bad).slice(0, TITLE_LENGTH)}`, async () => {
    const job = await openJob("implement");
    try {
      savePrHistory(job.cfg, bad);
      assert.throws(() => readWriteAuthority(job.cfg, ISSUE));
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    } finally {
      job.close();
    }
  });
}

for (const wrong of [
  { number: PR + 1 },
  { headRefName: "stale-branch" },
  { headRefOid: "" },
  { baseRefName: "main" },
  { isCrossRepository: true },
  { mergeCommit: { oid: "unexpected" } },
]) {
  test(`discovered PR identity cannot authorize a draft save: ${JSON.stringify(wrong)}`, async () => {
    const job = await openJob("implement");
    try {
      const original = headOf(job.repo);
      savePrHistory(job.cfg, [{ number: PR }]);
      savePrAuthority(job.cfg, {
        number: PR,
        state: "OPEN",
        headRefName: job.branch,
        headRefOid: original,
        baseRefName: job.cfg.baseBranch,
        isCrossRepository: false,
        mergeCommit: null,
        ...wrong,
      });
      assert.throws(() => readWriteAuthority(job.cfg, ISSUE));
      assert.throws(() => saveDraftAuthority(job.cfg, ISSUE, PR, original));
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    } finally {
      job.close();
    }
  });
}

test("a stale head cannot be saved; a validated draft saves only its PR identity and preserves provenance", async () => {
  const job = await openJob("implement");
  try {
    const original = headOf(job.repo);
    const revision = { code: original, inputs: "trusted" };
    const state = {
      ...newIssueState(ISSUE),
      branch: job.branch,
      stage: "implement",
      hardened: revision,
      integration: { reviewed: revision, revision },
    };
    saveAuthority(job.cfg, state);
    savePrAuthority(job.cfg, {
      number: PR,
      state: "OPEN",
      headRefName: job.branch,
      headRefOid: original,
      baseRefName: job.cfg.baseBranch,
      isCrossRepository: false,
      mergeCommit: null,
    });
    assert.throws(() => saveDraftAuthority(job.cfg, ISSUE, PR, "stale-head"));
    saveDraftAuthority(job.cfg, ISSUE, PR, original);
    assert.deepEqual(readWriteState(job.cfg, ISSUE), { ...state, pr: PR });
  } finally {
    job.close();
  }
});
