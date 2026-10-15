// The ops CLI's pure helpers, pinned to the behaviour ops.mjs had before they
// moved to src/*.ts (#166).
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";

process.env.ISSUE_PIPELINE_ROOT = "/opt/pipeline-root";
const { globToRegExp, matchAny } = await import("../src/globs.ts");
const { signature, signed } = await import("../src/comments.ts");
const { ghIsRead, redactGhArgs } = await import("../src/github.ts");
const { redactLocalPaths, HOME } = await import("../src/pipeline-root.ts");
const { parseStateBody, newState } = await import("../src/state.ts");

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
    "**🤖 issue-pipeline · Reviewer (scope)**\n<sub>agent `a` · model `m` · run `r`</sub>\n<!-- agent-pipeline:comment role=reviewer-scope -->",
  );
  assert.equal(
    signature(undefined),
    "**🤖 issue-pipeline · pipeline**\n<sub>deterministic step, no model</sub>\n<!-- agent-pipeline:comment role=pipeline -->",
  );
  assert.equal(signed({ role: "x" }, "y".repeat(70_000)).length, 65_000);
});

test("text posted to GitHub names local paths by variable", () => {
  assert.equal(
    redactLocalPaths(`/opt/pipeline-root/runs and ${HOME}/x`),
    "$ISSUE_PIPELINE_ROOT/runs and ~/x",
  );
  assert.deepEqual(
    redactGhArgs(["api", `/opt/pipeline-root`, "-f", "body=/opt/pipeline-root/a", "--title", `${HOME}/t`]),
    ["api", "/opt/pipeline-root", "-f", "body=$ISSUE_PIPELINE_ROOT/a", "--title", "~/t"],
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
  const state = newState(7, 1);
  const body = `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>x</sub>`;
  assert.deepEqual(parseStateBody(body), state);
  assert.equal(parseStateBody("no mark"), null);
  assert.equal(parseStateBody("<!-- agent-pipeline:state {bad -->"), null);
  assert.deepEqual(Object.keys(state), ["version", "number", "depth", "stage", "lease", "pr", "headSha", "reviewedSha", "verifiedSha", "plan", "allocated", "reportedTokens", "sessions", "triages", "continuations", "round", "ciFixes", "syncs", "findings", "resolvedHistory", "questionsAt", "log"]);
});
