// @ts-check
// The brain (src/job/brain.ts): the wiki clone --brain-path names, from
// which a stage job pins its sessions' behavioral prompts, one page per
// session as the reviewer-flow contract maps them. The job pins only its
// stage's pages, byte for byte with each page's sha256 and the clone's HEAD,
// and keeps them though the clone changes. A missing, linked, empty,
// one-line or non-UTF-8 page, or a brain that isn't a folder, fails the job
// before it runs an op or starts pi, for a run and a boundary print alike.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";
import {
  headsWithGit,
  PROMPT_PAGES,
  pageTextOf,
  writeBrain,
} from "./brain-test-kit.mjs";
import { AUTHOR_SESSION, READER_STAGE, repliesAt } from "./job-fixtures.mjs";
import {
  flagValue,
  logOf,
  piStarts,
  runJob,
  setUp,
  statusOf,
} from "./job-test-kit.mjs";

const { PROMPT_PAGES: SOURCE_PAGES, openBrain } = await import(
  "../src/job/brain.ts"
);

const AUTHOR_PAGE = "Pipeline-Prompt-Author.md";
const NO_BRAIN = /--brain-path must name a clone of the repo's wiki/u;
const NOT_A_FOLDER = /isn't a folder/u;
const CANT_READ = /can't read .*Pipeline-Prompt-Author\.md/u;
const NOT_TEXT = /Pipeline-Prompt-Author\.md isn't a prompt page of text/u;
const NOT_UTF8 = /Pipeline-Prompt-Author\.md isn't UTF-8/u;
const COMMIT_ID = /^[0-9a-f]{40}$/u;
const SHA1_HEX_LENGTH = 40;
const SHA256_HEX_LENGTH = 64;
// "#", a byte no UTF-8 text holds, and a newline.
const NOT_UTF8_BYTES = Buffer.from("23ff0a", "hex");
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com"];

// A job whose claim would run the author, so a failure is the only reason
// it runs nothing.
function place() {
  return setUp(repliesAt(READER_STAGE), AUTHOR_SESSION);
}

/** @param {string} text @returns {string} its sha256, hex */
function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * How the job in `at` ended, `r`, and whether it ran an op or a pi.
 * @param {ReturnType<typeof place>} at
 * @param {{ status: number | null, stderr: string }} r
 * @param {RegExp} pattern the failure its stderr should name
 */
function failureOf(at, r, pattern) {
  const ran = logOf(at, "ops.log").length + logOf(at, "pi.log").length;
  return { status: r.status, named: pattern.test(r.stderr), ran };
}

const FAILED = { status: 1, named: true, ran: 0 };

test("each session's page is the one the reviewer-flow contract names, and the test kit writes the same pages", () => {
  assert.deepEqual(SOURCE_PAGES, PROMPT_PAGES);
});

test("a job pins only its stage's pages, byte for byte, and keeps them though the brain changes", () => {
  const at = place();
  const text = "\uFEFF# Security\r\n\r\nLook for what an attacker gets.  \n";
  const page = "Pipeline-Prompt-Security.md";
  fs.writeFileSync(path.join(at.brain, page), text);
  const brain = openBrain(at.brain, "merge");
  fs.writeFileSync(path.join(at.brain, page), "Changed.\nSince.\n");
  assert.equal(brain.promptFor("merge", "security-review")?.text, text);
  assert.deepEqual(brain.promptFor("merge", "security-review")?.provenance, {
    page,
    path: path.join(at.brain, page),
    sha256: sha256Of(text),
    head: null,
  });
  assert.deepEqual(
    brain.pinned.map((pinned) => pinned.page),
    ["Pipeline-Prompt-Integration.md", page],
  );
  assert.equal(brain.promptFor("merge", null), null);
  assert.equal(brain.promptFor("merge", "hardening"), null);
  assert.equal(brain.promptFor("review", "hardening"), null);
});

test("a brain that is its own git checkout records its HEAD; a folder inside one records none", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain]);
  execFileSync("git", [...GIT, "-C", at.brain, "add", "."]);
  execFileSync("git", [...GIT, "-C", at.brain, "commit", "-qm", "pages"]);
  const head = execFileSync("git", ["-C", at.brain, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.match(head, COMMIT_ID);
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [head, head],
  );
  const inner = writeBrain(path.join(at.brain, "inner"));
  assert.deepEqual(
    openBrain(inner, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
});

test("a brain outside a checkout or with no committed HEAD pins pages with null heads", () => {
  const at = place();
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
  execFileSync("git", ["init", "-q", at.brain]);
  assert.deepEqual(
    openBrain(at.brain, "merge").pinned.map((pinned) => pinned.head),
    [null, null],
  );
});

test("Git reporting the top level without a HEAD line pins null, not an empty head", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain]);
  assert.equal(headsWithGit(at, ""), "[null,null]\n");
});

test("Git root and HEAD reads are independent and every page records the valid full commit", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain]);
  const head = "a".repeat(SHA1_HEX_LENGTH);
  assert.equal(
    headsWithGit(at, `${head}\n`),
    `${JSON.stringify([head, head])}\n`,
  );
});

test("unavailable or malformed HEAD output pins every page with a null head", () => {
  const at = place();
  execFileSync("git", ["init", "-q", at.brain]);
  for (const { name, head, code } of [
    {
      name: "failed HEAD read",
      head: `${"a".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 1,
    },
    { name: "whitespace HEAD", head: " \t\n", code: 0 },
    { name: "short HEAD", head: "abc123\n", code: 0 },
    {
      name: "uppercase HEAD",
      head: `${"A".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 0,
    },
    { name: "non-hex HEAD", head: `${"g".repeat(SHA1_HEX_LENGTH)}\n`, code: 0 },
    {
      name: "SHA-256 HEAD",
      head: `${"a".repeat(SHA256_HEX_LENGTH)}\n`,
      code: 0,
    },
    {
      name: "multiple HEAD lines",
      head: `${"a".repeat(SHA1_HEX_LENGTH)}\n${"b".repeat(SHA1_HEX_LENGTH)}\n`,
      code: 0,
    },
  ]) {
    assert.equal(headsWithGit(at, head, code), "[null,null]\n", name);
  }
});

test("the author job's pi gets its page appended to its system prompt, and job.json and the usage record name where it came from", () => {
  const at = place();
  const r = runJob(at, ["--stage", READER_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const [start] = piStarts(at);
  const appended = flagValue(start.argv, "--append-system-prompt");
  assert.equal(appended, pageTextOf(AUTHOR_PAGE));
  const sha256 = sha256Of(pageTextOf(AUTHOR_PAGE));
  const status = statusOf(at);
  assert.deepEqual(status.prompts, [
    {
      page: AUTHOR_PAGE,
      path: path.join(at.brain, AUTHOR_PAGE),
      sha256,
      head: null,
    },
  ]);
  const launched = status.launches.filter(
    (/** @type {any} */ { kind }) => kind === "session",
  );
  assert.deepEqual(
    launched.map((/** @type {any} */ { prompt }) => prompt),
    [{ page: AUTHOR_PAGE, sha256 }],
  );
  const usage = logOf(at, "ops.log").filter(({ op }) => op === "usage");
  const records = usage.map(({ line }) => JSON.parse(line));
  const session = records.find(({ kind }) => kind === "session");
  assert.deepEqual(session.prompt, { page: AUTHOR_PAGE, sha256, head: null });
});

test("a run or a boundary print without a brain, or with one that isn't a folder, fails before anything runs", () => {
  const at = place();
  const file = path.join(at.tmp, "file");
  fs.writeFileSync(file, "");
  for (const extra of [[], ["--print-boundary"]]) {
    const args = ["--stage", READER_STAGE, ...extra];
    const none = runJob(at, [...args, "--brain-path="]);
    assert.deepEqual(failureOf(at, none, NO_BRAIN), FAILED);
    const notFolder = runJob(at, [...args, "--brain-path", file]);
    assert.deepEqual(failureOf(at, notFolder, NOT_A_FOLDER), FAILED);
  }
});

test("a page that is missing, a link, empty, one line or not UTF-8 fails the job before anything runs", () => {
  const at = place();
  const page = path.join(at.brain, AUTHOR_PAGE);
  const outside = path.join(at.tmp, "outside.md");
  fs.writeFileSync(outside, pageTextOf(AUTHOR_PAGE));
  // Each case starts with the page gone, so the first leaves it missing.
  /** @type {[(() => void), RegExp][]} */
  const broken = [
    [() => undefined, CANT_READ],
    [() => fs.symlinkSync(outside, page), CANT_READ],
    [() => fs.writeFileSync(page, " \n\n"), NOT_TEXT],
    [() => fs.writeFileSync(page, "One line only."), NOT_TEXT],
    [() => fs.writeFileSync(page, NOT_UTF8_BYTES), NOT_UTF8],
  ];
  for (const [breakPage, pattern] of broken) {
    fs.rmSync(page, { force: true });
    breakPage();
    for (const extra of [[], ["--print-boundary"]]) {
      const r = runJob(at, ["--stage", READER_STAGE, ...extra]);
      assert.deepEqual(failureOf(at, r, pattern), FAILED, r.stderr);
    }
  }
});
