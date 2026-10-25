// @ts-check
// Lost authority is reconciliation, not a fresh issue, when prior work survives.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { collaboratorReply } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { kit, LANE, openIssue } from "../ops-v2-test-kit.mjs";

const {
  askOps,
  commentsReply,
  issueComment,
  reply,
  root,
  runDir,
  sh,
  worktree,
  writes,
} = kit;
const RECONCILE =
  /prior pipeline work but no saved authority; stop for reconciliation/u;
const FIRST = 810;
const HISTORY_PR = 42;
const LOCAL_REF_ISSUE = 820;
const UNREADABLE_HISTORY_ISSUE = 821;

/** @param {number} number @returns {string[]} */
function survivingFiles(number) {
  return [
    path.join(worktree(number), "held.txt"),
    path.join(runDir(number), "held.bundle"),
  ].flatMap((file) => {
    if (!fs.existsSync(file)) {
      return [];
    }
    return [fs.readFileSync(file, "utf8")];
  });
}

/** @param {number} number @param {string} evidence @returns {object[]} */
function priorWork(number, evidence) {
  const branch = `agent/issue-${number}`;
  if (evidence === "source branch") {
    sh(`git -C ${root}/seed push -q origin HEAD:refs/heads/${branch}`);
  }
  if (evidence === "local work") {
    fs.mkdirSync(worktree(number), { recursive: true });
    fs.writeFileSync(path.join(worktree(number), "held.txt"), "must survive\n");
  }
  if (evidence === "recovery bundle") {
    fs.mkdirSync(runDir(number), { recursive: true });
    fs.writeFileSync(
      path.join(runDir(number), "held.bundle"),
      "must survive\n",
    );
  }
  if (evidence === "machine comment") {
    return [
      issueComment(
        1,
        "**🤖 issue-pipeline · coordinator**\n<!-- agent-pipeline:comment role=coordinator -->",
      ),
    ];
  }
  return [];
}

/** @param {number} number @returns {unknown} */
function claimWithoutAuthority(number) {
  reply([
    openIssue(number),
    collaboratorReply("o/r", "alice"),
    { ...commentsReply(number, []), keep: true },
    historyReply(number),
  ]);
  return askOps({ op: "claim", number, ...LANE });
}

test("missing state preserves a retained local code branch and its unpushed commits without a worktree", () => {
  const number = LOCAL_REF_ISSUE;
  const clone = path.join(root, "clones", "o__r");
  const branch = `refs/heads/agent/issue-${number}`;
  const base = sh(`git -C ${clone} rev-parse origin/integration`);
  const tree = sh(`git -C ${clone} rev-parse ${base}^{tree}`);
  const commit = sh(
    `git -C ${clone} -c user.name=test -c user.email=test@example.test commit-tree ${tree} -p ${base} -m retained-local-work`,
  );
  sh(`git -C ${clone} update-ref ${branch} ${commit}`);
  const refsBefore = sh(`git -C ${clone} for-each-ref --contains=${commit}`);
  const commitBefore = sh(`git -C ${clone} cat-file commit ${commit}`);
  const remoteCommits = sh(`git -C ${root}/origin.git rev-list --all`).split(
    "\n",
  );
  assert.equal(remoteCommits.includes(commit), false);
  assert.equal(fs.existsSync(worktree(number)), false);
  const result = claimWithoutAuthority(number);
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string",
  );
  assert.match(result.error, RECONCILE);
  assert.deepEqual(writes(), []);
  assert.equal(sh(`git -C ${clone} rev-parse ${branch}`), commit);
  assert.equal(sh(`git -C ${clone} cat-file commit ${commit}`), commitBefore);
  assert.equal(
    sh(`git -C ${clone} for-each-ref --contains=${commit}`),
    refsBefore,
  );
  assert.equal(fs.existsSync(worktree(number)), false);
});

test("missing state refuses unreadable local code history instead of treating it as absent", () => {
  const mirror = path.join(root, "work", "o__r", "mirror.git");
  sh(`git clone -q --mirror ${root}/origin.git ${mirror}`);
  const packed = path.join(mirror, "packed-refs");
  const unreadable = "invalid packed reference history\n";
  fs.writeFileSync(packed, unreadable);
  try {
    const result = claimWithoutAuthority(UNREADABLE_HISTORY_ISSUE);
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string",
    );
    assert.match(result.error, RECONCILE);
    assert.deepEqual(writes(), []);
    assert.equal(fs.readFileSync(packed, "utf8"), unreadable);
  } finally {
    fs.rmSync(mirror, { recursive: true });
  }
});

for (const [index, evidence] of [
  "source branch",
  "local work",
  "recovery bundle",
  "machine comment",
  "PR history",
].entries()) {
  test(`missing state with surviving ${evidence} never posts a claim or initializes authority`, () => {
    const number = FIRST + index;
    const comments = priorWork(number, evidence);
    let history = historyReply(number);
    if (evidence === "PR history") {
      history = historyReply(number, [HISTORY_PR]);
    }
    const before = survivingFiles(number);
    reply([
      openIssue(number),
      collaboratorReply("o/r", "alice"),
      { ...commentsReply(number, comments), keep: true },
      history,
    ]);
    // The job's own checkout, apart from the issue's worktree, as a stage
    // job's always is, so local work there counts as prior work.
    const checkout = {
      issue: number,
      dir: path.join(root, `job-claim-${number}`),
      branch: `agent/issue-${number}`,
    };
    const result = askOps({ op: "claim", number, ...LANE, checkout });
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "error" in result &&
        typeof result.error === "string",
    );
    assert.match(result.error, RECONCILE);
    assert.deepEqual(writes(), []);
    assert.deepEqual(survivingFiles(number), before);
  });
}
