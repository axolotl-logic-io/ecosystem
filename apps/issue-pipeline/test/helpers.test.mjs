// @ts-check
// The ops CLI's pure helpers, pinned to the behaviour ops.mjs had before they
// moved to src/*.ts (#166).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

// A body longer than a GitHub comment, and the length signed() clips it to.
const BASE_OR_WIKI = /is the base or wiki branch/u;
const OVERLONG_BODY = 70_000;
const COMMENT_LIMIT = 65_000;
// The issue a new state is made for, and its PR.
const STATE_ISSUE = 7;
const STATE_PR = 12;
// The installed version's spend fields in an old state comment.
const ALLOCATED = 1_990_000;
const REBASE_ALLOCATED = 450_000;

const { globToRegExp, matchAny } = await import("../src/globs.ts");
const { signature, signed } = await import("../src/comments.ts");
const { ghIsRead, redactGhArgs } = await import("../src/github.ts");
const { redactLocalPaths, HOME } = await import("../src/pipeline-root.ts");
const { newIssueState } = await import("../src/state.ts");
const { parseStateBody, stateBody } = await import("../src/saved-state.ts");
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
    redactLocalPaths(`${isolatedRoot}/runs and ${HOME}/x`),
    "$ISSUE_PIPELINE_ROOT/runs and ~/x",
  );
  assert.deepEqual(
    redactGhArgs([
      "api",
      isolatedRoot,
      "-f",
      `body=${isolatedRoot}/a`,
      "--title",
      `${HOME}/t`,
    ]),
    [
      "api",
      isolatedRoot,
      "-f",
      "body=$ISSUE_PIPELINE_ROOT/a",
      "--title",
      "~/t",
    ],
  );
});

// Text that names no address: times, a SHA and a version (#385).
const NOT_ADDRESSES =
  "at 01:02:03, 01:02Z and 2026-10-17T13:52:55.123Z, head ad7243c0123456789abcdef0123456789abcdef0, v1.2.3";

test("text posted to GitHub hides IP addresses, with or without a port", () => {
  assert.deepEqual(
    redactGhArgs([
      "api",
      "repos/o/r/issues/7/comments",
      "-f",
      "body=read tcp 10.0.0.5:51234->1.2.3.4:443: read: connection reset",
      "--title",
      "from [2001:db8::1]:443, 2001:db8::1, fe80::1 and 2001:0db8:0000:0000:0000:ff00:0042:8329",
      "--body",
      NOT_ADDRESSES,
    ]),
    [
      "api",
      "repos/o/r/issues/7/comments",
      "-f",
      "body=read tcp [redacted]->[redacted]: read: connection reset",
      "--title",
      "from [redacted], [redacted], [redacted] and [redacted]",
      "--body",
      NOT_ADDRESSES,
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

test("a saved state with the installed version's spend fields still loads, without them", () => {
  const state = { ...newIssueState(STATE_ISSUE), pr: STATE_PR };
  const withSpend = {
    ...state,
    allocated: ALLOCATED,
    rebaseAllocated: REBASE_ALLOCATED,
    rechecking: true,
    sessions: ["triage", "spec"],
  };
  const body = `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(withSpend)}\n-->\n<sub>x</sub>`;
  assert.deepEqual(parseStateBody(body, STATE_ISSUE), state);
});

test("a state comment's body gives its state, or null", () => {
  const state = { ...newIssueState(STATE_ISSUE), pr: STATE_PR };
  const body = stateBody(STATE_ISSUE, state);
  assert.deepEqual(parseStateBody(body, STATE_ISSUE), state);
  assert.equal(parseStateBody("no mark", STATE_ISSUE), null);
  assert.equal(
    parseStateBody("<!-- agent-pipeline:state {bad -->", STATE_ISSUE),
    null,
  );
  // What the wiki says the state comment holds, in any order.
  const promised = [
    "version",
    "stage",
    "lease",
    "pr",
    "headSha",
    "gherkin",
    "review",
    "verifiedSha",
    "codeMerged",
  ];
  assert.deepEqual(
    promised.filter((key) => !(key in state)),
    [],
  );
});

test("a job checkout stands in for its own issue's worktree and branch, with the wiki checkout docs/ beside it, and for its issue only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-paths-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "o__r.json");
  const checkout = {
    issue: STATE_ISSUE,
    dir: "/jobs/issue-7-spec/repo",
    branch: "feature/seven",
  };
  const config = {
    repo: "o/r",
    ...credentialConfig("bot"),
    allowedUsers: ["alice"],
    commands: { test: "true" },
    wiki: { dir: "wiki" },
    checkout,
  };
  fs.writeFileSync(file, JSON.stringify(config));
  const cfg = loadConfig(file);
  assert.equal(cfg.checkout, undefined);
  const work = `${isolatedRoot}/work/o__r`;
  assert.equal(paths.worktree(cfg, STATE_ISSUE), `${work}/issue-7`);
  assert.equal(paths.wiki(cfg, STATE_ISSUE), `${work}/issue-7/wiki`);
  const scoped = withCheckout(cfg, checkout);
  assert.equal(paths.worktree(scoped, STATE_ISSUE), "/jobs/issue-7-spec/repo");
  assert.equal(paths.wiki(scoped, STATE_ISSUE), "/jobs/issue-7-spec/docs");
  assert.equal(paths.branch(scoped, STATE_ISSUE), "feature/seven");
  assert.equal(paths.branch(cfg, STATE_ISSUE), "agent/issue-7");
  const other = STATE_ISSUE + 1;
  assert.equal(paths.worktree(scoped, other), `${work}/issue-${other}`);
  assert.equal(paths.branch(scoped, other), `agent/issue-${other}`);
  // The configured base (main by default) and wiki branch are no issue's.
  for (const branch of ["main", "master"]) {
    const unsafe = withCheckout(cfg, { ...checkout, branch });
    assert.throws(() => paths.branch(unsafe, STATE_ISSUE), BASE_OR_WIKI);
  }
  assert.equal(withCheckout(cfg, null), cfg);
});
