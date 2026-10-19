// @ts-check
// Lost authority is reconciliation, not a fresh issue, when prior work survives.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { collaboratorReply } from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import { kit, LANE, openIssue } from "./ops-v2-test-kit.mjs";

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
  if (evidence === "private wiki ref") {
    const mirror = path.join(root, "work", "o__r", "wiki-mirror.git");
    sh(`git clone -q --bare ${root}/origin.git ${mirror}`);
    sh(
      `git -C ${mirror} update-ref refs/heads/${branch} refs/heads/integration`,
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

for (const [index, evidence] of [
  "source branch",
  "local work",
  "recovery bundle",
  "private wiki ref",
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
    const result = askOps({ op: "claim", number, ...LANE });
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
