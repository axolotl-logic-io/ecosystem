// @ts-check
// The spec writer's ready reply may point at its committed spec draft
// instead of retyping it (`specInDraft`, spec-practices-digest): the job
// reads the reply with the draft at the checkout's head in `spec`
// (src/job/reply-file.ts), so the session's reply check and the role judge
// the draft's text, and a reply that points at a draft the branch lacks
// fails with that reason. A reply that gives the spec inline still reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { replyFiller } from "../src/job/reply-file.ts";
import { specReadingOf } from "../src/roles/spec-writer/reply.ts";
import { sessionFindings } from "../src/roles/spec-writer/reply-faults.ts";
import { endsWithTest } from "./bounded-test-kit.mjs";
import { replyOf } from "./spec-writer-role-test-kit.mjs";

const DRAFT = ".issue-pipeline/spec-draft.md";
const SPEC_END = "<!-- end of spec -->";
const NO_DRAFT = "the reply points at the spec draft, but the branch has none";
const DRAFT_SPEC = "## Behaviour\n\n- It works.\n- It also scales.";
const REPLY_FILE = { path: DRAFT, field: "spec", flag: "specInDraft" };

/** @returns {readonly never[]} no git-only failures */
function noGitFailures() {
  return [];
}

/** @param {string} dir @param {readonly string[]} args */
function git(dir, args) {
  const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (ran.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${ran.stderr}`);
  }
}

// A git checkout whose head holds the spec draft `draft`, or none.
/** @param {string | null} draft @returns {string} the checkout */
function checkoutWith(draft) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-draft-reply-"));
  endsWithTest(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "README.md"), "x\n");
  if (draft !== null) {
    fs.mkdirSync(path.join(dir, ".issue-pipeline"));
    fs.writeFileSync(path.join(dir, DRAFT), draft);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"]);
  return dir;
}

test("a ready reply in the draft reads the draft's spec, with no end marker needed", () => {
  const reading = specReadingOf(
    replyOf({ spec: DRAFT_SPEC, specInDraft: true }),
    0,
  );
  assert.equal(reading.kind, "ready");
  assert.ok(reading.kind === "ready");
  assert.equal(reading.reply.spec, DRAFT_SPEC);
  assert.ok(!("specInDraft" in reading.reply));
});

test("a reply in the draft with no draft committed fails with that reason", () => {
  const reading = specReadingOf(replyOf({ spec: "", specInDraft: true }), 0);
  assert.deepEqual(reading, { kind: "bad", reason: NO_DRAFT });
});

test("a reply that gives the spec inline, with or without specInDraft, still reads", () => {
  for (const fields of [{}, { specInDraft: false }]) {
    const reading = specReadingOf(replyOf(fields), 0);
    assert.equal(reading.kind, "ready", JSON.stringify(fields));
  }
});

test("the job fills a reply in the draft with the draft at the head", () => {
  const repo = checkoutWith(`${DRAFT_SPEC}\n\n${SPEC_END}\n`);
  const fill = replyFiller(repo, REPLY_FILE);
  const filled = fill(replyOf({ spec: "", specInDraft: true }));
  const reading = specReadingOf(filled, 0);
  assert.ok(reading.kind === "ready", JSON.stringify(reading));
  assert.equal(reading.reply.spec, DRAFT_SPEC);
});

test("the job leaves a reply as given when it gives the spec inline or the head has no draft", () => {
  const inline = replyOf({ specInDraft: false });
  assert.equal(
    replyFiller(checkoutWith(DRAFT_SPEC), REPLY_FILE)(inline),
    inline,
  );
  const pointing = replyOf({ spec: "", specInDraft: true });
  assert.equal(replyFiller(checkoutWith(null), REPLY_FILE)(pointing), pointing);
  assert.equal(replyFiller("/nowhere", undefined)(pointing), pointing);
});

test("the session's reply check judges coverage on the draft's text, and names a missing draft", () => {
  const pointing = replyOf({ spec: "", specInDraft: true });
  const repo = checkoutWith(DRAFT_SPEC);
  const findings = sessionFindings(
    replyFiller(repo, REPLY_FILE)(pointing),
    0,
    noGitFailures,
  );
  assert.ok(
    findings?.includes('items 2 ("It also scales.")'),
    String(findings),
  );
  const missing = sessionFindings(
    replyFiller(checkoutWith(null), REPLY_FILE)(pointing),
    0,
    noGitFailures,
  );
  assert.ok(missing?.includes(NO_DRAFT), String(missing));
});
