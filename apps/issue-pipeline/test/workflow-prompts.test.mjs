// @ts-check
// The opening lines of every child's task, and how comments are signed. The
// preamble is checked for the facts a session needs, not its wording; the
// signature for the role, agent, model and run the wiki's
// Running-the-Issue-Pipeline page promises.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitOftenRule,
  handoffRule,
  preamble,
} from "../src/workflow/prompts.ts";
import { by, byStep } from "../src/workflow/signing.ts";

const cfg = { repo: "o/r", baseBranch: "integration" };

// Issue #7, with its wiki checked out at `wiki`, or none.
/** @param {string | null} wiki @returns {Parameters<typeof preamble>[1]} */
function itemWith(wiki) {
  return {
    n: 7,
    paths: {
      worktree: "/w/issue-7",
      issueFile: "/runs/issue.md",
      wiki,
      handoffFile: "/runs/issue-7/handoff.md",
    },
  };
}

// The preamble's text for a fixer on issue #7, with `wiki` as its wiki.
/** @param {string | null} wiki @returns {string} */
function fixerPreamble(wiki) {
  return preamble(cfg, itemWith(wiki), "fixer").join("\n");
}

test("the preamble names the role, the worktree, its branch and the issue", () => {
  const text = fixerPreamble(null);
  for (const fact of [
    "fixer",
    "/w/issue-7",
    "agent/issue-7",
    "/runs/issue.md",
  ]) {
    assert.ok(text.includes(fact), `${fact} missing from:\n${text}`);
  }
});

test("the preamble gives no context budget (Axlog, 2026-10-16)", () => {
  assert.equal(fixerPreamble(null).includes("Context budget"), false);
});

test("a writer is told to commit small, working steps often, and how", () => {
  const rule = commitOftenRule("commit each step with `git commit`");
  assert.ok(rule.startsWith("Commit often, in small working steps:"));
  assert.ok(rule.includes("commit each step with `git commit`"));
  assert.ok(rule.includes("Don't save your work for one commit at the end"));
});

test("a writer wraps up at soft into a handoff summary, and is stopped at hard (wrap-up-at-175k)", () => {
  const limits = { softLimit: 175_000, hardLimit: 225_000 };
  const rule = handoffRule(
    limits,
    "/runs/issue-7/handoff.md",
    "make it build and commit it",
  );
  const promised = [
    "175000",
    "finish the edit you are in the middle of",
    "make it build and commit it",
    "/runs/issue-7/handoff.md",
    "summary for the next round",
    "what is done",
    "what is left",
    "decisions",
    "traps and dead ends",
    "branch state",
    "`handoff`",
    "225000",
  ];
  for (const part of promised) {
    assert.ok(rule.includes(part), `${part} in: ${rule}`);
  }
});

test("the preamble points at the wiki checkout only when there is one", () => {
  assert.ok(fixerPreamble("/w/issue-7/wiki").includes("/w/issue-7/wiki"));
  assert.equal(fixerPreamble(null).includes("wiki"), false);
});

test("a deterministic step signs with its role alone", () => {
  assert.deepEqual(byStep("CI"), {
    role: "CI",
    agent: null,
    model: null,
    run: null,
  });
});

const specMeta = {
  "i7-fix-3": { agent: "issue-pipeline-writer", model: "anthropic/claude-x" },
};

test("a child signs with its agent, its model's name and its run id", () => {
  assert.deepEqual(by(specMeta, { key: "i7-fix-3", runId: "r1" }, "fixer"), {
    role: "fixer",
    agent: "issue-pipeline-writer",
    model: "claude-x",
    run: "r1",
  });
});

test("a child with no run id signs with its key", () => {
  const signed = by(specMeta, { key: "i7-fix-3" }, "fixer");
  assert.equal(signed.run, "i7-fix-3");
});

test("the result's own agent comes before the launch's", () => {
  const signed = by(specMeta, { key: "i7-fix-3", agent: "other" }, "fixer");
  assert.equal(signed.agent, "other");
});

test("a child with no launch record signs without a model", () => {
  assert.deepEqual(by(specMeta, { key: "unknown" }, "fixer"), {
    role: "fixer",
    agent: null,
    model: null,
    run: "unknown",
  });
});

test("a missing result signs with the role alone", () => {
  assert.deepEqual(by(specMeta, null, "fixer"), byStep("fixer"));
  assert.deepEqual(by(specMeta, undefined, "fixer"), byStep("fixer"));
});
