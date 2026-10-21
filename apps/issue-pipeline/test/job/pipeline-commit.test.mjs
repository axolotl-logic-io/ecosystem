// What a pipeline_commit call plans before git runs: the refused flags and paths, how pathspecs
// route to the code checkout (repo/, whose docs are in repo/docs/), the access
// refusals (#338), the session trailer every commit ends with, and none for a
// scope without the job's start, and the dry run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitArgsOf, sessionTrailer } from "../../src/job/pipeline-commit.ts";

/** @typedef {import("../../src/job/pipeline-commit.ts").PathScope} PathScope */

/**
 * @param {"read" | "write"} repo
 * @param {readonly string[]} allowed
 * @returns {PathScope}
 */
function scopeOf(repo, allowed = ["**"]) {
  return { repo: { dir: "repo", access: repo }, allowed };
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

const WRITE = scopeOf("write");

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
  const scope = scopeOf("write", ["src/**"]);
  assert.ok(
    refusal(["-m", "x", "--", "repo/README.md"], scope).includes(
      "repo/README.md",
    ),
  );
  assert.ok(refusal(["-m", "x", "../out.txt"]).includes("../out.txt"));
  assert.ok(refusal(["-m", "x", "/etc/passwd"]).includes("/etc/passwd"));
  assert.ok(refusal(["-m", "x", ":(glob)**"]).includes(":(glob)"));
});

test("a path outside repo/ is refused, naming it and the checkout", () => {
  const error = refusal(["-m", "x", "--", "src/a.ts"]);
  assert.ok(error.includes("src/a.ts"));
  assert.ok(error.includes("repo/"));
});

test("a docs/ path beside repo/ is refused: the repo's docs are in repo/docs/", () => {
  const error = refusal(["-m", "x", "docs/Home.md"]);
  assert.ok(error.includes("docs/Home.md"));
  assert.ok(error.includes("paths start with repo/"));
});

test("a code path is refused without write access to the code, naming the checkout and the access", () => {
  const error = refusal(
    ["-m", "x", "--", "repo/README.md"],
    scopeOf("read", []),
  );
  assert.ok(error.includes("repo/README.md"));
  assert.ok(error.includes("code checkout (repo/)"));
  assert.ok(error.includes("read access"));
});

test("pathspecs lose their repo/ prefix, docs included, and go to the code checkout", () => {
  const plan = planned([
    "-m",
    "Add",
    "--",
    "repo/src/a.ts",
    "repo/docs/Home.md",
  ]);
  assert.deepEqual(plan.code, [
    "commit",
    "-m",
    "Add",
    ...TRAILER,
    "--",
    "src/a.ts",
    "docs/Home.md",
  ]);
  assert.equal(plan.dryRun, false);
  const codeOnly = planned(["-m", "Code", "repo"]);
  assert.deepEqual(codeOnly.code, [
    "commit",
    "-m",
    "Code",
    ...TRAILER,
    "--",
    ".",
  ]);
});

test("every commit ends with the session's trailer, naming its launch key and the job's start", () => {
  assert.equal(
    SESSION,
    "Pipeline-Session: i7-implement-1@2026-10-17T12:00:00.000Z",
  );
  const plan = planned(["-am", "Work"]);
  assert.deepEqual(plan.code?.slice(-2), TRAILER);
});

test("a scope without the job's start, as a job started before the trailer sends, commits without a trailer", () => {
  const trailer = sessionTrailer({ key: "i7-implement-1" });
  assert.equal(trailer, null);
  const plan = commitArgsOf(["-am", "Work"], WRITE, trailer);
  assert.equal(plan.kind, "commit");
  if (plan.kind !== "commit") {
    return;
  }
  assert.deepEqual(plan.code, ["commit", "-am", "Work"]);
});

test("the call's own message options, trailer and signoff pass through before the session's trailer", () => {
  const trailer = "Pipeline-Agent: implementer";
  const plan = planned(["-am", "Fix it", "--trailer", trailer, "-s"]);
  assert.deepEqual(plan.code, [
    "commit",
    "-am",
    "Fix it",
    `--trailer=${trailer}`,
    "-s",
    ...TRAILER,
  ]);
});

test("a relative message file is read from the job's folder", () => {
  const plan = planned(["-F", "msg.txt"]);
  assert.deepEqual(plan.code, ["commit", "-F", "../msg.txt", ...TRAILER]);
  const long = planned(["--file", "m.txt"]);
  assert.deepEqual(long.code, ["commit", "--file", "../m.txt", ...TRAILER]);
  const absolute = planned(["-F", "/tmp/m.txt"]);
  assert.deepEqual(absolute.code, ["commit", "-F", "/tmp/m.txt", ...TRAILER]);
});

test("a scope that may not write code, as after the code merged, plans no commit and refuses a code path", () => {
  for (const scope of [scopeOf("read", []), scopeOf("write", [])]) {
    assert.equal(planned(["-am", "x"], scope).code, null);
    assert.ok(
      refusal(["-m", "x", "repo/src/a.ts"], scope).includes("repo/src/a.ts"),
    );
  }
});

test("--dry-run passes through and marks the plan a dry run", () => {
  const plan = planned(["--dry-run", "-am", "x"]);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.code?.includes("--dry-run"));
});
