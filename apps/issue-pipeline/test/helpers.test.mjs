// @ts-check
// The ops CLI's pure helpers, pinned to the behaviour ops.mjs had before they
// moved to src/*.ts (#166).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

// A body longer than a GitHub comment, and the length signed() clips it to.
const OVERLONG_BODY = 70_000;
const COMMENT_LIMIT = 65_000;
// The issue a new state is made for.
const STATE_ISSUE = 7;

// Environment variables are named by strings, as src/process.ts takes them.
Object.assign(
  process.env,
  Object.fromEntries([["ISSUE_PIPELINE_ROOT", "/opt/pipeline-root"]]),
);
const { globToRegExp, matchAny } = await import("../src/globs.ts");
const { signature, signed } = await import("../src/comments.ts");
const { ghIsRead, redactGhArgs } = await import("../src/github.ts");
const { redactLocalPaths, HOME } = await import("../src/pipeline-root.ts");
const { parseStateBody, newState } = await import("../src/state.ts");
const { loadConfig, paths, withCheckout } = await import("../src/config.ts");

test("globs match within a segment, across segments, and any leading folders", () => {
  assert.equal(matchAny(["**/*.md"], "README.md"), true);
  assert.equal(matchAny(["**/*.md"], "docs/a/b.md"), true);
  assert.equal(matchAny(["docs/*"], "docs/a/b.md"), false);
  assert.equal(matchAny(["test_?.py"], "test_1.py"), true);
  assert.equal(matchAny(["a.b"], "aXb"), false);
  assert.equal(matchAny(undefined, "x"), false);
  assert.equal(globToRegExp("src/**").test("src/a/b.ts"), true);
});

test("a signature names the role, agent, model and run", () => {
  assert.equal(
    signature({ role: "Reviewer (scope)", agent: "a", model: "m", run: "r" }),
    [
      "**🤖 issue-pipeline · Reviewer (scope)**",
      "<sub>agent `a` · model `m` · run `r`</sub>",
      "<!-- agent-pipeline:comment role=reviewer-scope -->",
    ].join("\n"),
  );
  assert.equal(
    signature(undefined),
    "**🤖 issue-pipeline · pipeline**\n<sub>deterministic step, no model</sub>\n<!-- agent-pipeline:comment role=pipeline -->",
  );
  assert.equal(
    signed({ role: "x" }, "y".repeat(OVERLONG_BODY)).length,
    COMMENT_LIMIT,
  );
});

test("text posted to GitHub names local paths by variable", () => {
  assert.equal(
    redactLocalPaths(`/opt/pipeline-root/runs and ${HOME}/x`),
    "$ISSUE_PIPELINE_ROOT/runs and ~/x",
  );
  assert.deepEqual(
    redactGhArgs([
      "api",
      "/opt/pipeline-root",
      "-f",
      "body=/opt/pipeline-root/a",
      "--title",
      `${HOME}/t`,
    ]),
    [
      "api",
      "/opt/pipeline-root",
      "-f",
      "body=$ISSUE_PIPELINE_ROOT/a",
      "--title",
      "~/t",
    ],
  );
});

test("only GETs and list or view commands count as reads", () => {
  assert.equal(ghIsRead(["api", "repos/o/r/issues"]), true);
  assert.equal(ghIsRead(["api", "-X", "POST", "x"]), false);
  assert.equal(ghIsRead(["api", "x", "-f", "a=b"]), false);
  assert.equal(ghIsRead(["pr", "view", "1"]), true);
  assert.equal(ghIsRead(["pr", "merge", "1"]), false);
});

test("a state comment's body gives its state, or null", () => {
  const state = newState(STATE_ISSUE, 1);
  const body = `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>x</sub>`;
  assert.deepEqual(parseStateBody(body), state);
  assert.equal(parseStateBody("no mark"), null);
  assert.equal(parseStateBody("<!-- agent-pipeline:state {bad -->"), null);
  assert.deepEqual(Object.keys(state), [
    "version",
    "number",
    "depth",
    "stage",
    "lease",
    "pr",
    "headSha",
    "reviewedSha",
    "verifiedSha",
    "plan",
    "allocated",
    "rebaseAllocated",
    "rechecking",
    "reportedTokens",
    "sessions",
    "triages",
    "continuations",
    "round",
    "ciFixes",
    "syncs",
    "findings",
    "resolvedHistory",
    "questionsAt",
    "log",
  ]);
});

test("a job checkout stands in for its own issue's worktree and wiki only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-paths-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "o__r.json");
  const checkout = { issue: STATE_ISSUE, dir: "/jobs/issue-7-spec" };
  const config = {
    repo: "o/r",
    account: "bot",
    allowedUsers: ["alice"],
    commands: { test: "true" },
    wiki: { dir: "docs" },
    checkout,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  const cfg = loadConfig(file);
  assert.equal(cfg.checkout, undefined);
  const work = "/opt/pipeline-root/work/o__r";
  assert.equal(paths.worktree(cfg, STATE_ISSUE), `${work}/issue-7`);
  assert.equal(paths.wiki(cfg, STATE_ISSUE), `${work}/issue-7/docs`);
  const scoped = withCheckout(cfg, checkout);
  assert.equal(paths.worktree(scoped, STATE_ISSUE), "/jobs/issue-7-spec");
  assert.equal(paths.wiki(scoped, STATE_ISSUE), "/jobs/issue-7-spec/docs");
  const other = STATE_ISSUE + 1;
  assert.equal(paths.worktree(scoped, other), `${work}/issue-${other}`);
  assert.equal(withCheckout(cfg, null), cfg);
});
