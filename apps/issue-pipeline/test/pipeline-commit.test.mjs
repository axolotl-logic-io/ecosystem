// What a pipeline_commit call plans before git runs (wiki
// Pipeline-Job-Contract#pipeline_commit): the refused flags and paths, how pathspecs
// route to the code checkout (repo/) and the wiki checkout (docs/), the access
// refusals (#338), the wiki's commit of everything with the same message,
// the session trailer every commit ends with, and none for a scope without
// the job's start, and the dry run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitArgsOf, sessionTrailer } from "../src/job/pipeline-commit.ts";

/** @typedef {import("../src/job/pipeline-commit.ts").PathScope} PathScope */

/**
 * @param {"read" | "write"} repo
 * @param {"read" | "write" | null} docs
 * @param {readonly string[]} allowed
 * @returns {PathScope}
 */
function scopeOf(repo, docs, allowed = ["**"]) {
  if (docs === null) {
    return { repo: { dir: "repo", access: repo }, docs: null, allowed };
  }
  return {
    repo: { dir: "repo", access: repo },
    docs: { dir: "docs", access: docs },
    allowed,
  };
}

// The trailer of session i7-implement-1 of a job started at noon.
const SESSION = sessionTrailer({
  key: "i7-implement-1",
  jobStartedAt: "2026-10-17T12:00:00.000Z",
});
if (SESSION === null) {
  throw new Error("a scope with the job's start has a trailer");
}
const TRAILER = ["--trailer", SESSION];

const WRITE = scopeOf("write", "write");
const READ = scopeOf("write", "read");

/** @param {string[]} args @param {PathScope} scope */
function refusal(args, scope = WRITE) {
  const plan = commitArgsOf(args, scope, SESSION);
  if (plan.kind !== "refused") {
    throw new Error(`not refused: ${JSON.stringify(args)}`);
  }
  return plan.error;
}

/** @param {string[]} args @param {PathScope} scope */
function planned(args, scope = WRITE) {
  const plan = commitArgsOf(args, scope, SESSION);
  if (plan.kind !== "commit") {
    throw new Error(`refused: ${plan.error}`);
  }
  return plan;
}

test("flags that rewrite history, skip hooks, change the identity or read hidden input are refused", () => {
  const refused = [
    ["--amend", "-m", "x"],
    ["--amen", "-m", "x"],
    ["--no-verify", "-m", "x"],
    ["-n", "-m", "x"],
    ["-an", "-m", "x"],
    ["--author", "A <a@b>", "-m", "x"],
    ["--author=x", "-m", "x"],
    ["--date", "now", "-m", "x"],
    ["--date=now", "-m", "x"],
    ["--reset-author", "-m", "x"],
    ["--pathspec-from-file=list", "-m", "x"],
    ["-F", "-"],
    ["--file=-"],
  ];
  for (const args of refused) {
    assert.ok(refusal(args).length > 0, JSON.stringify(args));
  }
});

test("a path outside the session's allowed paths is refused, naming it", () => {
  const scope = scopeOf("write", "write", ["src/**"]);
  assert.ok(
    refusal(["-m", "x", "--", "repo/README.md"], scope).includes(
      "repo/README.md",
    ),
  );
  assert.ok(refusal(["-m", "x", "../out.txt"]).includes("../out.txt"));
  assert.ok(refusal(["-m", "x", "/etc/passwd"]).includes("/etc/passwd"));
  assert.ok(refusal(["-m", "x", ":(glob)**"]).includes(":(glob)"));
});

test("a path outside repo/ and docs/ is refused, naming it and the checkouts", () => {
  const error = refusal(["-m", "x", "--", "src/a.ts"]);
  assert.ok(error.includes("src/a.ts"));
  assert.ok(error.includes("repo/"));
  assert.ok(error.includes("docs/"));
});

test("a wiki path is refused without write access to the wiki, naming the checkout and the access", () => {
  const error = refusal(["-m", "x", "--", "docs/Home.md"], READ);
  assert.ok(error.includes("docs/Home.md"));
  assert.ok(error.includes("wiki checkout (docs/)"));
  assert.ok(error.includes("read access"));
});

test("a code path is refused without write access to the code, naming the checkout and the access", () => {
  const merger = scopeOf("read", "write", []);
  const error = refusal(["-m", "x", "--", "repo/README.md"], merger);
  assert.ok(error.includes("repo/README.md"));
  assert.ok(error.includes("code checkout (repo/)"));
  assert.ok(error.includes("read access"));
});

test("a docs/ path is refused in a job with no wiki checkout", () => {
  const error = refusal(["-m", "x", "docs/x"], scopeOf("write", null));
  assert.ok(error.includes("docs/x"));
});

test("pathspecs lose their repo/ or docs/ prefix and go to that checkout", () => {
  const plan = planned(["-m", "Add", "--", "repo/src/a.ts", "docs/Home.md"]);
  const add = ["commit", "-m", "Add", ...TRAILER];
  assert.deepEqual(plan.code, [...add, "--", "src/a.ts"]);
  assert.deepEqual(plan.wiki, [
    ["add", "-A", "--", "Home.md"],
    [...add, "--", "Home.md"],
  ]);
  assert.equal(plan.dryRun, false);
  const wikiOnly = planned(["-m", "Page", "docs/New.md"]);
  assert.equal(wikiOnly.code, null);
  assert.deepEqual(wikiOnly.wiki?.[1], [
    "commit",
    "-m",
    "Page",
    ...TRAILER,
    "--",
    "New.md",
  ]);
  const codeOnly = planned(["-m", "Code", "repo"]);
  assert.deepEqual(codeOnly.code, [
    "commit",
    "-m",
    "Code",
    ...TRAILER,
    "--",
    ".",
  ]);
  assert.equal(codeOnly.wiki, null);
});

test("every commit, code or wiki, ends with the session's trailer, naming its launch key and the job's start", () => {
  assert.equal(
    SESSION,
    "Pipeline-Session: i7-implement-1@2026-10-17T12:00:00.000Z",
  );
  const plan = planned(["-am", "Work"]);
  assert.deepEqual(plan.code?.slice(-2), TRAILER);
  assert.deepEqual(plan.wiki?.[1]?.slice(-2), TRAILER);
});

test("a scope without the job's start, as a job started before the trailer sends, commits code and wiki without a trailer", () => {
  const trailer = sessionTrailer({ key: "i7-implement-1" });
  assert.equal(trailer, null);
  const plan = commitArgsOf(["-am", "Work"], WRITE, trailer);
  assert.equal(plan.kind, "commit");
  if (plan.kind !== "commit") {
    return;
  }
  assert.deepEqual(plan.code, ["commit", "-am", "Work"]);
  assert.deepEqual(plan.wiki, [
    ["add", "-A"],
    ["commit", "-m", "Work"],
  ]);
});

test("with no pathspec the wiki adds every change and commits it with the same message", () => {
  const trailer = "Pipeline-Agent: implementer";
  const plan = planned(["-am", "Fix it", "--trailer", trailer]);
  assert.equal(plan.code?.[0], "commit");
  assert.ok(plan.code?.includes("-am"));
  assert.deepEqual(plan.wiki, [
    ["add", "-A"],
    ["commit", "-m", "Fix it", "--trailer", trailer, ...TRAILER],
  ]);
  const signed = planned(["--message=Docs", "-s"]);
  assert.deepEqual(signed.wiki?.[1], [
    "commit",
    "-m",
    "Docs",
    "-s",
    ...TRAILER,
  ]);
});

test("a relative message file is read from the job's folder in both checkouts", () => {
  const plan = planned(["-F", "msg.txt"]);
  assert.deepEqual(plan.code, ["commit", "-F", "../msg.txt", ...TRAILER]);
  assert.deepEqual(plan.wiki?.[1], ["commit", "-F", "../msg.txt", ...TRAILER]);
  const long = planned(["--file", "m.txt"]);
  assert.deepEqual(long.code, ["commit", "--file", "../m.txt", ...TRAILER]);
  assert.deepEqual(long.wiki?.[1], ["commit", "-F", "../m.txt", ...TRAILER]);
  const absolute = planned(["-F", "/tmp/m.txt"]);
  assert.deepEqual(absolute.code, ["commit", "-F", "/tmp/m.txt", ...TRAILER]);
});

test("with no pathspec, only the checkouts the stage may write are planned", () => {
  assert.equal(planned(["-am", "x"], READ).wiki, null);
  assert.equal(planned(["-am", "x"], scopeOf("write", null)).wiki, null);
  const merger = planned(["-m", "x"], scopeOf("read", "write", []));
  assert.equal(merger.code, null);
  assert.notEqual(merger.wiki, null);
});

test("a session that may commit only the wiki plans no code commit", () => {
  const wikiOnly = scopeOf("write", "write", []);
  assert.equal(planned(["-m", "x"], wikiOnly).code, null);
  assert.ok(
    refusal(["-m", "x", "repo/src/a.ts"], wikiOnly).includes("repo/src/a.ts"),
  );
});

test("--dry-run passes through, marks the plan a dry run and runs no add", () => {
  const plan = planned(["--dry-run", "-am", "x"]);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.code?.includes("--dry-run"));
  for (const argv of plan.wiki ?? []) {
    assert.notEqual(argv[0], "add");
    assert.ok(argv.includes("--dry-run"));
  }
});
