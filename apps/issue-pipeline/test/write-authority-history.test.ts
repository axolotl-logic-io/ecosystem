// Null saved PRs are not evidence that an actual PR never existed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headOf, ISSUE, openJob } from "./pipeline-commit-test-kit.ts";
import {
  saveAuthority,
  savePrAuthority,
  savePrHistory,
} from "./write-authority-test-kit.ts";

const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { readWriteAuthority }: typeof import("../src/write-authority.ts") =
  await import("../src/write-authority.ts");
const { saveDraftAuthority }: typeof import("../src/ops/pr-state.ts") =
  await import("../src/ops/pr-state.ts");
const { readWriteState }: typeof import("../src/saved-state.ts") = await import(
  "../src/saved-state.ts"
);
const PR = 42;
const TITLE_LENGTH = 45;
const CLOSED_REFUSAL = /is closed; code authority needs operator recovery/u;

for (const status of ["OPEN", "MERGED"]) {
  test(`all-state discovery validates actual ${status} identity with saved pr:null`, async () => {
    const job = await openJob("implement");
    try {
      const original = headOf(job.repo);
      savePrHistory(job.cfg, [{ number: PR }]);
      let mergeCommit: { oid: string } | null = null;
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
      assert.equal(
        readWriteAuthority(job.cfg, ISSUE).codeWritable,
        status === "OPEN",
      );
      // Discovery cannot forge an own-merge/approval or silently save a receipt.
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
      assert.equal(readWriteState(job.cfg, ISSUE).codeMerged, null);
    } finally {
      job.close();
    }
  });
}

const HISTORY_SHAPE = { name: "ZodError" };
for (const { bad, refusal } of [
  { bad: null, refusal: HISTORY_SHAPE },
  { bad: {}, refusal: HISTORY_SHAPE },
  { bad: [{ number: "42" }], refusal: HISTORY_SHAPE },
  {
    bad: [{ number: PR }, { number: PR + 1 }],
    refusal: /PR history is saturated or ambiguous/u,
  },
  {
    bad: Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })),
    refusal: /PR history is saturated or ambiguous/u,
  },
]) {
  test(`malformed, unreadable, ambiguous or saturated PR history refuses: ${JSON.stringify(bad).slice(0, TITLE_LENGTH)}`, async () => {
    const job = await openJob("implement");
    try {
      savePrHistory(job.cfg, bad);
      assert.throws(() => readWriteAuthority(job.cfg, ISSUE), refusal);
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    } finally {
      job.close();
    }
  });
}

const WRONG_PRS: { wrong: Record<string, unknown>; refusal: RegExp }[] = [
  { wrong: { number: PR + 1 }, refusal: /is not from .* so it isn't/u },
  {
    wrong: { headRefName: "stale-branch" },
    refusal: /is not from .* so it isn't/u,
  },
  { wrong: { headRefOid: "" }, refusal: /reply for PR #42 doesn't parse/u },
  { wrong: { baseRefName: "main" }, refusal: /targets main, not integration/u },
  {
    wrong: { isCrossRepository: true },
    refusal: /is not from .* so it isn't/u,
  },
  {
    wrong: { mergeCommit: { oid: "unexpected" } },
    refusal: /has inconsistent merge evidence/u,
  },
];
for (const { wrong, refusal } of WRONG_PRS) {
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
      assert.throws(() => readWriteAuthority(job.cfg, ISSUE), refusal);
      assert.throws(
        () => saveDraftAuthority(job.cfg, ISSUE, PR, original),
        refusal,
      );
      assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    } finally {
      job.close();
    }
  });
}

const STALE_DRAFT = /has no matching open draft authority/u;

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
    assert.throws(
      () => saveDraftAuthority(job.cfg, ISSUE, PR, "stale-head"),
      STALE_DRAFT,
    );
    saveDraftAuthority(job.cfg, ISSUE, PR, original);
    assert.deepEqual(readWriteState(job.cfg, ISSUE), { ...state, pr: PR });
  } finally {
    job.close();
  }
});

test("closed PR discovery refuses specifically instead of granting code authority", async () => {
  const job = await openJob("implement");
  try {
    savePrHistory(job.cfg, [{ number: PR }]);
    savePrAuthority(job.cfg, {
      number: PR,
      state: "CLOSED",
      headRefName: job.branch,
      headRefOid: headOf(job.repo),
      baseRefName: job.cfg.baseBranch,
      isCrossRepository: false,
      mergeCommit: null,
    });
    assert.throws(() => readWriteAuthority(job.cfg, ISSUE), CLOSED_REFUSAL);
    assert.equal(readWriteState(job.cfg, ISSUE).pr, null);
    assert.equal(readWriteState(job.cfg, ISSUE).codeMerged, null);
  } finally {
    job.close();
  }
});
