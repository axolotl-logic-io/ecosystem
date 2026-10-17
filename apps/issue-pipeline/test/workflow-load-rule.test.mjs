// @ts-check
// Every writer's task carries one rule against artificial load on the shared
// machine (#409): the implementer, the fixer, the CI fixer, the conflict
// resolver in the code and wiki checkouts, and the spec writer in the sweep
// and in its role. The tests build each task from its stage and read the
// text; they run no model, timer or load.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_ARTIFICIAL_LOAD_RULE } from "../src/workflow/prompts.ts";
import { next as checks } from "../src/workflow/stages/checks.ts";
import { next as fix } from "../src/workflow/stages/fix.ts";
import { next as implement } from "../src/workflow/stages/implement.ts";
import { next as merge } from "../src/workflow/stages/merge.ts";
import { next as spec } from "../src/workflow/stages/spec.ts";
import { next as sync } from "../src/workflow/stages/sync.ts";
import { ruleCount, taskOf } from "./load-rule-test-kit.mjs";
import { retried } from "./spec-writer-role-test-kit.mjs";
import { BUILD_CTX, buildState } from "./workflow-build-test-kit.mjs";
import {
  CTX as CHECKS_CTX,
  replied as checksReplied,
  stateAt,
} from "./workflow-checks-test-kit.mjs";
import {
  CTX as FINISH_CTX,
  replied as finishReplied,
  stateWith as finishState,
} from "./workflow-finish-test-kit.mjs";
import { fixState } from "./workflow-fix-test-kit.mjs";
import { CTX as REVIEW_CTX } from "./workflow-review-test-kit.mjs";

// What each item the rule forbids, or asks for instead, is called in its
// text, case aside.
const SHARED_MACHINE = /\bshared\b/iu;
const OTHER_ISSUES = /\bother issues\b/iu;
const BUSY_LOOPS = /\bbusy loops?\b/iu;
const STRESS_TOOLS = /\bstress\b/iu;
const CPU_ONLY = /\bCPU\b/u;
const REPEATED_RUNS = /\brepeat/iu;
const FLAKES = /\bflak/iu;
const BACKGROUND = /\bbackground\b/iu;
const DETACHED = /\bdetached\b/iu;
const OUTLIVE = /\boutlives?\b/iu;
const SECOND_COPY = /\bsecond copy\b/iu;
const THE_APP = /\bapp\b/iu;
const TEST_DATABASE = /\btest database\b/iu;
const LOGS = /\blogs?\b/iu;
const TIMINGS = /\btimings?\b/iu;
const ONCE = /\bonce\b/iu;
const FOREGROUND = /\bforeground\b/iu;
const TIMEOUT = /\btimeout\b/iu;
const REPLY = /\breply\b/iu;
const EVIDENCE = /\bevidence\b/iu;
const NOT_REPRODUCED =
  /\b(?:not|never|don't|do not)\b[^.]*\breproduc|\bwithout reproducing\b/iu;
/** @type {ReadonlyArray<readonly [string, readonly RegExp[]]>} */
const RULE_ITEMS = [
  ["the machine is shared", [SHARED_MACHINE, OTHER_ISSUES]],
  [
    "busy loops, stress tools and CPU-only processes",
    [BUSY_LOOPS, STRESS_TOOLS, CPU_ONLY],
  ],
  ["repeated runs to find flakes", [REPEATED_RUNS, FLAKES]],
  [
    "background or detached runs that outlive their command",
    [BACKGROUND, DETACHED, OUTLIVE],
  ],
  [
    "a second copy of the app or the test database",
    [SECOND_COPY, THE_APP, TEST_DATABASE],
  ],
  ["reasoning from the failing run's logs and timings", [LOGS, TIMINGS]],
  ["each failing test file once, in the foreground", [ONCE, FOREGROUND]],
  ["stopping a command past the repo's timeout", [TIMEOUT]],
  [
    "reporting a suspected flake in the reply with evidence, not reproducing it",
    [REPLY, EVIDENCE, NOT_REPRODUCED],
  ],
];

const FAILING = {
  ok: true,
  headSha: "cccccccccccccccc",
  pass: false,
  checks: [{ id: "test", pass: false, detail: "1 failed", tail: "3 != 2" }],
};
const CODE_CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};
const WIKI_CONFLICT = {
  ...CODE_CONFLICT,
  conflicts: ["Home.md"],
  baseSha: "abcdefabcdefabcdef",
  branch: "master",
};

// The conflict resolver's task in the wiki checkout, from merge.
/** @returns {string} */
function wikiResolverTask() {
  const given = finishState("merge", { acceptReason: "Does it." });
  const withWiki = { ...given, paths: { ...given.paths, wiki: "/w/wiki" } };
  const begun = merge(withWiki, FINISH_CTX, []);
  return taskOf(finishReplied(merge, begun, WIKI_CONFLICT));
}

// Each writer's task, built by its stage or role as the pipeline builds it.
/** @type {ReadonlyArray<readonly [string, () => string]>} */
const WRITER_TASKS = [
  [
    "the implementer",
    () => taskOf(implement(buildState("implement"), BUILD_CTX, [])),
  ],
  ["the fixer", () => taskOf(fix(fixState(), REVIEW_CTX, []))],
  [
    "the CI fixer",
    () => {
      const begun = checks(stateAt("checks"), CHECKS_CTX, []);
      return taskOf(checksReplied(checks, begun, FAILING));
    },
  ],
  [
    "the conflict resolver in the code checkout",
    () => {
      const begun = sync(stateAt("sync"), CHECKS_CTX, []);
      return taskOf(checksReplied(sync, begun, CODE_CONFLICT));
    },
  ],
  ["the conflict resolver in the wiki checkout", wikiResolverTask],
  [
    "the sweep's spec writer",
    () => taskOf(spec(buildState("spec"), BUILD_CTX, [])),
  ],
  ["the spec writer role", () => retried().task],
];

describe("the rule against artificial load", () => {
  test("is one named constant with text", () => {
    assert.equal(typeof NO_ARTIFICIAL_LOAD_RULE, "string");
    assert.notEqual(NO_ARTIFICIAL_LOAD_RULE.trim(), "");
  });

  for (const [item, patterns] of RULE_ITEMS) {
    test(`names ${item}`, () => {
      for (const pattern of patterns) {
        assert.match(NO_ARTIFICIAL_LOAD_RULE, pattern);
      }
    });
  }
});

describe("every writer's task carries the rule once", () => {
  for (const [who, build] of WRITER_TASKS) {
    test(`${who}`, () => {
      assert.notEqual(NO_ARTIFICIAL_LOAD_RULE.trim(), "");
      assert.equal(
        ruleCount(build()),
        1,
        `${who}'s task carries the rule once`,
      );
    });
  }
});
