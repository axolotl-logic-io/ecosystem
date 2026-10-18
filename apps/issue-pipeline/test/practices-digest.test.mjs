// @ts-check
// The spec writer reads the coding practices' digest (config
// `practicesDigest`, spec-practices-digest) in place of the full files, and
// opens a full file only for a rule that bears on its work. Every other role
// still reads the full files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { OpsError } from "../src/process.ts";
import { practicesNote } from "../src/workflow/practices.ts";

const DIGEST = "wiki/Coding-Practices-Digest.md";
const PRACTICES = ["AGENTS.md", "wiki/Decisions-Code-and-tooling.md"];
// A stage job's item: its wiki checkout sits beside the code checkout.
const JOB_ITEM = {
  n: 7,
  paths: {
    worktree: "/job/repo",
    issueFile: "/runs/issue.md",
    wiki: "/job/docs",
    handoffFile: "/runs/handoff.md",
  },
};
const CFG = { practices: PRACTICES, practicesDigest: DIGEST, wiki: true };

test("the spec writer reads the digest, in the wiki checkout", () => {
  const note = practicesNote(CFG, JOB_ITEM, "spec");
  assert.ok(note.includes("read their digest in full: /job/docs/"), note);
  assert.ok(note.includes("/job/docs/Coding-Practices-Digest.md"), note);
  assert.ok(!note.includes("read each of these in full"), note);
});

test("the digest note names the full files, which win", () => {
  const note = practicesNote(CFG, JOB_ITEM, "spec");
  assert.ok(note.includes("/job/repo/AGENTS.md"), note);
  assert.ok(note.includes("/job/docs/Decisions-Code-and-tooling.md"), note);
  assert.ok(note.includes("which win where they differ"), note);
  assert.ok(note.includes("If the digest doesn't exist, read each"), note);
});

test("the digest note asks the spec writer to keep the digest current", () => {
  const note = practicesNote(CFG, JOB_ITEM, "spec");
  assert.ok(note.includes("update the digest in the same wiki commit"), note);
});

test("writers and reviewers still read the full files", () => {
  for (const use of /** @type {const} */ (["writer", "reviewer"])) {
    const note = practicesNote(CFG, JOB_ITEM, use);
    assert.ok(note.includes("read each of these in full"), use);
    assert.ok(!note.includes("digest"), use);
  }
});

test("with no digest the spec writer reads the full files", () => {
  const note = practicesNote(
    { practices: PRACTICES, practicesDigest: null },
    JOB_ITEM,
    "spec",
  );
  assert.ok(note.includes("read each of these in full"), note);
  assert.ok(!note.includes("digest"), note);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-digest-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
// A config file with the required fields and `extra`.
/** @param {object} extra @returns {string} */
function configWith(extra) {
  const file = path.join(tmp, `${Math.random()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo: "o/r",
      account: "a",
      allowedUsers: ["a"],
      commands: { test: "true" },
      ...extra,
    }),
  );
  return file;
}

test("the digest defaults to the wiki's practices digest page", () => {
  assert.equal(loadConfig(configWith({})).practicesDigest, DIGEST);
  assert.equal(
    loadConfig(configWith({ practicesDigest: null })).practicesDigest,
    null,
  );
});

test("the digest must stay inside the worktree", () => {
  for (const bad of ["/etc/passwd", "../x.md", ""]) {
    assert.throws(
      () => loadConfig(configWith({ practicesDigest: bad })),
      OpsError,
      JSON.stringify(bad),
    );
  }
});
