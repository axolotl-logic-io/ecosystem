// @ts-check
// Strict mutation eligibility cannot launder a tolerant display read into authority.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { commentLines, githubComment } from "./fake-gh.mjs";
import {
  claimMutationReplies,
  collaboratorReply,
} from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import {
  commitOnOrigin,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  v2State,
} from "./ops-v2-test-kit.mjs";

kit.requireGhReplies();
const { askOps, CONFIG, reply, root, sh, stateComment, worktree, writes } = kit;
const { loadConfig } = await import("../src/config.ts");
const { listComments } = await import("../src/comments.ts");
const { readClaimState, readWriteState } = await import(
  "../src/saved-state.ts"
);
const cfg = loadConfig(CONFIG);
const NUMBER = 991;
const LEGACY_NUMBER = 992;
const LEGACY_PR = 47;
const STATE_ID = 1;
const LATEST_ID = 3;
const NO_AUTHORITY = /no saved authority; stop for reconciliation/u;
const LEGACY = /legacy pipeline state needs explicit reconciliation/u;
const REFUSED = z.looseObject({
  ok: z.literal(false),
  error: z.string().min(1),
});
const saved = v2State(NUMBER, {
  branch: `agent/issue-${NUMBER}`,
  lease: { ...LANE, at: "2026-10-18T00:00:00Z" },
});
const wt = worktree(NUMBER);
fs.mkdirSync(path.dirname(wt), { recursive: true });
sh(
  `git clone -q ${root}/origin.git ${wt} && git -C ${wt} checkout -qb agent/issue-${NUMBER}`,
);
fs.writeFileSync(path.join(wt, "held.txt"), "original local commit\n");
sh(
  `git -C ${wt} add held.txt && git -C ${wt} -c user.name=Seed -c user.email=seed@example.com commit -qm held`,
);
const local = sh(`git -C ${wt} rev-parse HEAD`);
fs.writeFileSync(path.join(wt, "held.txt"), "staged\n");
sh(`git -C ${wt} add held.txt`);
fs.writeFileSync(path.join(wt, "held.txt"), "staged\nunstaged\n");
fs.writeFileSync(path.join(wt, "dirty.txt"), "untracked recovery\n");
const index = sh(
  `git -C ${wt} rev-parse --path-format=absolute --git-path index`,
);
const indexBefore = fs.readFileSync(index);
const refs = sh(`git -C ${root}/origin.git show-ref`);

/** @param {unknown} invalid @param {readonly object[]} [older] */
function authority(invalid, older = []) {
  const latest = githubComment({
    id: LATEST_ID,
    login: cfg.mergeAccount,
    created: "2026-10-18T01:00:00Z",
    body: `<!-- agent-pipeline:state\n${JSON.stringify(invalid)}\n-->`,
  });
  reply([
    openIssue(NUMBER),
    collaboratorReply("o/r", "alice"),
    {
      when: `issues/${NUMBER}/comments?per_page`,
      stdout: commentLines([...older, latest, myClaim(2)]),
      keep: true,
    },
  ]);
}

for (const invalid of [
  { pr: "broken" },
  { codeMerged: {} },
  { merged: {} },
  { security: {} },
  { hardened: {} },
  { integration: {} },
  { gherkin: {} },
  { flows: {} },
  { headSha: {} },
  { lease: {} },
  { branch: 42 },
  { stoppedStage: "invalid" },
  { stopCode: 42 },
  { version: 3 },
  { number: LEGACY_NUMBER },
]) {
  test(`existing invalid authority ${JSON.stringify(invalid)} cannot be normalized by claim, checkpoint, release or ask`, () => {
    const bad = { ...saved, ...invalid };
    authority(bad);
    assert.throws(() => readClaimState(cfg, NUMBER, listComments(cfg, NUMBER)));
    assert.throws(() => readWriteState(cfg, NUMBER));
    for (const op of ["claim", "save-state", "release", "ask"]) {
      authority(bad);
      const result = REFUSED.parse(
        askOps({
          op,
          number: NUMBER,
          state: saved,
          ...LANE,
          questions: ["Which?"],
          by: { role: "author" },
        }),
      );
      assert.equal(result.ok, false);
      assert.deepEqual(writes(), []);
      assert.equal(sh(`git -C ${wt} rev-parse HEAD`), local);
      assert.deepEqual(fs.readFileSync(index), indexBefore);
      assert.equal(
        fs.readFileSync(path.join(wt, "held.txt"), "utf8"),
        "staged\nunstaged\n",
      );
      assert.equal(
        fs.readFileSync(path.join(wt, "dirty.txt"), "utf8"),
        "untracked recovery\n",
      );
      assert.equal(sh(`git -C ${root}/origin.git show-ref`), refs);
    }
  });
}

for (const invalid of [
  null,
  {},
  { version: 99 },
  { version: 1, number: NUMBER },
  { version: 1, number: NUMBER, stage: "unknown" },
  { version: 1, number: NUMBER, stage: "review", pr: "broken" },
  { version: 1, number: NUMBER, stage: "review", security: null },
]) {
  test(`unknown or corrupt existing state is not a new or legacy claim: ${JSON.stringify(invalid)}`, () => {
    authority(invalid);
    const result = REFUSED.parse(
      askOps({ op: "claim", number: NUMBER, ...LANE }),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(writes(), []);
    assert.equal(sh(`git -C ${wt} rev-parse HEAD`), local);
    assert.deepEqual(fs.readFileSync(index), indexBefore);
  });
}

test("a latest malformed genuine state cannot fall back to an older valid state for any checkpoint path", () => {
  const older = stateComment(STATE_ID, saved);
  for (const op of ["claim", "save-state", "release", "ask"]) {
    authority({ ...saved, codeMerged: {} }, [older]);
    assert.equal(
      REFUSED.parse(
        askOps({
          op,
          number: NUMBER,
          state: saved,
          ...LANE,
          questions: ["Which?"],
          by: { role: "author" },
        }),
      ).ok,
      false,
    );
    assert.deepEqual(writes(), []);
  }
});

test("checkpoint, release and claim refuse missing authority beside prior claims and local work", () => {
  const comments = { ...kit.commentsReply(NUMBER, [myClaim(2)]), keep: true };
  for (const op of ["save-state", "release", "ask"]) {
    reply([comments]);
    assert.equal(
      REFUSED.parse(
        askOps({
          op,
          number: NUMBER,
          state: saved,
          ...LANE,
          questions: ["Which?"],
          by: { role: "author" },
        }),
      ).ok,
      false,
    );
    assert.deepEqual(writes(), []);
  }
  reply([comments]);
  assert.equal(readClaimState(cfg, NUMBER, listComments(cfg, NUMBER)), null);
  reply([
    openIssue(NUMBER),
    comments,
    historyReply(NUMBER),
    ...claimMutationReplies(NUMBER, STATE_ID, null),
  ]);
  const initial = REFUSED.parse(
    askOps({ op: "claim", number: NUMBER, ...LANE }),
  );
  assert.match(initial.error, NO_AUTHORITY);
  assert.deepEqual(writes(), []);
  assert.equal(sh(`git -C ${wt} rev-parse HEAD`), local);
  assert.deepEqual(fs.readFileSync(index), indexBefore);
  assert.equal(
    fs.readFileSync(path.join(wt, "held.txt"), "utf8"),
    "staged\nunstaged\n",
  );
});

test("an explicit genuine v1 state cannot be adopted by a claim", () => {
  const headSha = commitOnOrigin(
    `agent/issue-${LEGACY_NUMBER}`,
    "legacy-work.txt",
  );
  const legacy = {
    version: 1,
    number: LEGACY_NUMBER,
    stage: "review",
    pr: LEGACY_PR,
    headSha,
    lease: { ...LANE, at: "2020-01-01T00:00:00Z" },
    flows: { code: true },
    log: ["Retained legacy work"],
  };
  const comments = [stateComment(STATE_ID, legacy), myClaim(2)];
  reply([{ ...kit.commentsReply(LEGACY_NUMBER, comments), keep: true }]);
  assert.throws(
    () => readClaimState(cfg, LEGACY_NUMBER, listComments(cfg, LEGACY_NUMBER)),
    LEGACY,
  );
  reply([
    openIssue(LEGACY_NUMBER),
    { ...kit.commentsReply(LEGACY_NUMBER, comments), keep: true },
    prView(LEGACY_NUMBER, LEGACY_PR, { headRefOid: headSha }),
    ...claimMutationReplies(LEGACY_NUMBER, STATE_ID, LEGACY_PR),
  ]);
  const refused = REFUSED.parse(
    askOps({ op: "claim", number: LEGACY_NUMBER, ...LANE }),
  );
  assert.match(refused.error, LEGACY);
  assert.deepEqual(writes(), []);
});
