// What a pipeline_commit call plans before git runs (wiki Pipeline-Roles-
// Shared, "pipeline_commit"): the refused flags and paths, how pathspecs
// split between the code repo and the wiki, the wiki's commit of everything
// with the same message, and the dry run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commitArgsOf } from "../src/job/pipeline-commit.ts";

/** @typedef {import("../src/job/pipeline-commit.ts").PathScope} PathScope */

/** @type {PathScope} */
const WRITE = { wikiDir: "wiki", wikiAccess: "write", allowed: ["**"] };
/** @type {PathScope} */
const READ = { wikiDir: "wiki", wikiAccess: "read", allowed: ["**"] };

/** @param {string[]} args @param {PathScope} scope */
function refusal(args, scope = WRITE) {
  const plan = commitArgsOf(args, scope);
  if (plan.kind !== "refused") {
    throw new Error(`not refused: ${JSON.stringify(args)}`);
  }
  return plan.error;
}

/** @param {string[]} args @param {PathScope} scope */
function planned(args, scope = WRITE) {
  const plan = commitArgsOf(args, scope);
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
  /** @type {PathScope} */
  const scope = { wikiDir: "wiki", wikiAccess: "write", allowed: ["src/**"] };
  assert.ok(
    refusal(["-m", "x", "--", "README.md"], scope).includes("README.md"),
  );
  assert.ok(refusal(["-m", "x", "../out.txt"]).includes("../out.txt"));
  assert.ok(refusal(["-m", "x", "/etc/passwd"]).includes("/etc/passwd"));
  assert.ok(refusal(["-m", "x", ":(glob)**"]).includes(":(glob)"));
});

test("a wiki path is refused without write access to the wiki", () => {
  const error = refusal(["-m", "x", "--", "wiki/Home.md"], READ);
  assert.ok(error.includes("wiki/Home.md"));
});

test("wiki pathspecs go to the wiki, relative to it, and the rest to the code repo", () => {
  const plan = planned(["-m", "Add", "--", "src/a.ts", "wiki/Home.md"]);
  assert.deepEqual(plan.code, ["commit", "-m", "Add", "--", "src/a.ts"]);
  assert.deepEqual(plan.wiki, [
    ["add", "-A", "--", "Home.md"],
    ["commit", "-m", "Add", "--", "Home.md"],
  ]);
  assert.equal(plan.dryRun, false);
  const wikiOnly = planned(["-m", "Page", "wiki/New.md"]);
  assert.equal(wikiOnly.code, null);
  assert.deepEqual(wikiOnly.wiki?.[1], [
    "commit",
    "-m",
    "Page",
    "--",
    "New.md",
  ]);
});

test("with no wiki pathspec the wiki adds every change and commits it with the same message", () => {
  const trailer = "Pipeline-Agent: implementer";
  const plan = planned(["-am", "Fix it", "--trailer", trailer]);
  assert.equal(plan.code?.[0], "commit");
  assert.ok(plan.code?.includes("-am"));
  assert.deepEqual(plan.wiki, [
    ["add", "-A"],
    ["commit", "-m", "Fix it", "--trailer", trailer],
  ]);
  const signed = planned(["--message=Docs", "-s"]);
  assert.deepEqual(signed.wiki?.[1], ["commit", "-m", "Docs", "-s"]);
});

test("a relative message file is rewritten for the wiki folder", () => {
  const plan = planned(["-F", "msg.txt"]);
  assert.deepEqual(plan.code, ["commit", "-F", "msg.txt"]);
  assert.deepEqual(plan.wiki?.[1], ["commit", "-F", "../msg.txt"]);
  const nested = planned(["--file", "m.txt"], {
    ...WRITE,
    wikiDir: "docs/wiki",
  });
  assert.deepEqual(nested.wiki?.[1], ["commit", "-F", "../../m.txt"]);
});

test("without write access, or a wiki, nothing is planned for the wiki", () => {
  assert.equal(planned(["-am", "x"], READ).wiki, null);
  /** @type {PathScope} */
  const none = { wikiDir: null, wikiAccess: "none", allowed: ["**"] };
  assert.equal(planned(["-am", "x"], none).wiki, null);
});

test("a session that may commit only the wiki plans no code commit", () => {
  /** @type {PathScope} */
  const wikiOnly = { wikiDir: "wiki", wikiAccess: "write", allowed: [] };
  assert.equal(planned(["-m", "x"], wikiOnly).code, null);
  assert.ok(refusal(["-m", "x", "src/a.ts"], wikiOnly).includes("src/a.ts"));
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
