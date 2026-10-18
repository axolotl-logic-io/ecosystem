// @ts-check
// Every writer's task carries one rule against artificial load on the shared
// machine (#409): the implementer, the fixer, the CI fixer, the conflict
// resolver in the code and wiki checkouts, and the spec writer in the sweep
// and in its role. The tests build each task from its stage and read the
// text; they run no model, timer or load.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_ARTIFICIAL_LOAD_RULE } from "../src/workflow/prompts.ts";
import { ruleCount } from "./load-rule-test-kit.mjs";
import { WRITER_SESSIONS } from "./role-sessions-test-kit.mjs";

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
  for (const [who, build] of WRITER_SESSIONS) {
    test(`${who}`, () => {
      assert.notEqual(NO_ARTIFICIAL_LOAD_RULE.trim(), "");
      const tasks = build().map(({ task }) => task);
      assert.deepEqual(
        tasks.map(ruleCount),
        tasks.map(() => 1),
        `${who}'s task carries the rule once`,
      );
    });
  }
});
