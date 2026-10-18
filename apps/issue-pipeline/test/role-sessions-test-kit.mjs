// @ts-check
// The sessions each role launches, built by its stage or role as the pipeline
// builds them, for tests that read every task or agent: the writers (the
// implementer, the fixer, the CI fixer, the conflict resolver in the code and
// wiki checkouts, and the spec writer in the sweep and in its role) and the
// readers (triage, the three reviewers and their aggregator, the re-reviewer,
// the check fix's reviewers, the acceptance verifier and the security
// reviewer). They run no model, timer or load.
import { next as accept } from "../src/workflow/stages/accept.ts";
import { next as checks } from "../src/workflow/stages/checks.ts";
import { next as fix } from "../src/workflow/stages/fix.ts";
import { next as implement } from "../src/workflow/stages/implement.ts";
import { next as merge } from "../src/workflow/stages/merge.ts";
import { next as review } from "../src/workflow/stages/review.ts";
import { next as security } from "../src/workflow/stages/security.ts";
import { next as spec } from "../src/workflow/stages/spec.ts";
import { next as sync } from "../src/workflow/stages/sync.ts";
import { next as triage } from "../src/workflow/stages/triage.ts";
import { retried } from "./spec-writer-role-test-kit.mjs";
import { sessions } from "./stage-outcome-test-kit.mjs";
import { BUILD_CTX, buildState } from "./workflow-build-test-kit.mjs";
import {
  after,
  CTX as CHECKS_CTX,
  replied as checksReplied,
  sessionResult,
  stateAt,
} from "./workflow-checks-test-kit.mjs";
import {
  CTX as FINISH_CTX,
  replied as finishReplied,
  stateWith as finishState,
  prepared,
} from "./workflow-finish-test-kit.mjs";
import { fixState, round } from "./workflow-fix-test-kit.mjs";
import {
  OFF_BY_ONE,
  opReply,
  CTX as REVIEW_CTX,
  replied as reviewReplied,
  stateWith as reviewState,
} from "./workflow-review-test-kit.mjs";
import {
  CTX as TRIAGE_CTX,
  stateWith as triageState,
} from "./workflow-triage-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */
/** @import { Session } from "./stage-outcome-test-kit.mjs" */

const HEAD = "cccccccccccccccc";
const FIXED_HEAD = "ffffffffffffffff";
const FAILING = {
  ok: true,
  headSha: HEAD,
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
const REVIEW_DIFF = {
  ok: true,
  headSha: "ccccccc",
  diffPath: "/w/review.diff",
  diffLines: 12,
};

// Every session `step` launches; throws when it launches none.
/** @param {Step} step @returns {Session[]} */
function sessionsOf(step) {
  const launched = sessions(step);
  if (launched.length === 0) {
    throw new Error("the step launched no session");
  }
  return launched;
}

// The first session `step` launches, alone.
/** @param {Step} step @returns {Session[]} */
function firstSessionOf(step) {
  return sessionsOf(step).slice(0, 1);
}

// The conflict resolver's step in the wiki checkout, from merge.
/** @returns {Step} */
function wikiResolverLaunched() {
  const given = finishState("merge", { acceptReason: "Does it." });
  const withWiki = { ...given, paths: { ...given.paths, wiki: "/w/wiki" } };
  const begun = merge(withWiki, FINISH_CTX, []);
  return finishReplied(merge, begun, WIKI_CONFLICT);
}

// The review's step once its lenses are launched.
/** @returns {Step} */
function lensesLaunched() {
  const begun = review(reviewState("review"), REVIEW_CTX, []);
  return review(begun.state, REVIEW_CTX, [opReply(REVIEW_DIFF)]);
}

// The review's step once the lenses reported one blocking finding, which
// launches the aggregator.
/** @returns {Step} */
function aggregatorLaunched() {
  const lenses = lensesLaunched();
  const blocking = { findings: [{ severity: "blocking", ...OFF_BY_ONE }] };
  const results = ["correctness", "tests", "scope"].map((lens) => {
    if (lens === "correctness") {
      return reviewReplied(`review-${lens}`, blocking);
    }
    return reviewReplied(`review-${lens}`, { findings: [] });
  });
  return review(lenses.state, REVIEW_CTX, results);
}

// Checks' step once a CI fix is pushed and its diff prepared, which launches
// the check fix's reviewers.
/** @returns {Step} */
function checkFixReviewersLaunched() {
  const begun = checks(stateAt("checks"), CHECKS_CTX, []);
  const fixing = checksReplied(checks, begun, FAILING);
  const fixed = sessionResult("cifix-1", { status: "fixed", summary: "Done." });
  const pushing = after(checks, fixing, CHECKS_CTX, fixed);
  const preparing = checksReplied(checks, pushing, {
    ok: true,
    headSha: FIXED_HEAD,
  });
  return checksReplied(checks, preparing, { ok: true, diffPath: "/w/d.diff" });
}

// Each writer's session.
/** @type {ReadonlyArray<readonly [string, () => Session[]]>} */
const WRITER_SESSIONS = [
  [
    "the implementer",
    () => firstSessionOf(implement(buildState("implement"), BUILD_CTX, [])),
  ],
  ["the fixer", () => firstSessionOf(fix(fixState(), REVIEW_CTX, []))],
  [
    "the CI fixer",
    () => {
      const begun = checks(stateAt("checks"), CHECKS_CTX, []);
      return firstSessionOf(checksReplied(checks, begun, FAILING));
    },
  ],
  [
    "the conflict resolver in the code checkout",
    () => {
      const begun = sync(stateAt("sync"), CHECKS_CTX, []);
      return firstSessionOf(checksReplied(sync, begun, CODE_CONFLICT));
    },
  ],
  [
    "the conflict resolver in the wiki checkout",
    () => firstSessionOf(wikiResolverLaunched()),
  ],
  [
    "the sweep's spec writer",
    () => firstSessionOf(spec(buildState("spec"), BUILD_CTX, [])),
  ],
  ["the spec writer role", () => [retried()]],
];

// Each reader's sessions.
/** @type {ReadonlyArray<readonly [string, () => Session[]]>} */
const READER_SESSIONS = [
  ["triage", () => sessionsOf(triage(triageState(), TRIAGE_CTX, []))],
  ["the reviewers", () => sessionsOf(lensesLaunched())],
  ["the aggregator", () => sessionsOf(aggregatorLaunched())],
  ["the re-reviewer", () => sessionsOf(round(fixState()).prepared)],
  ["the check fix's reviewers", () => sessionsOf(checkFixReviewersLaunched())],
  [
    "the acceptance verifier",
    () => firstSessionOf(prepared(accept, finishState("accept"))),
  ],
  [
    "the security reviewer",
    () => firstSessionOf(prepared(security, finishState("security"))),
  ],
];

export { READER_SESSIONS, WRITER_SESSIONS };
