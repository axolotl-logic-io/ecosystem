// @ts-check
// The reviewer role's stage job for issue #7 at `review` (#421) and at
// `accept` (#423): the job with the fake ops and the fake pi
// (job-test-kit.mjs), the issue claimed as today's stage saved it, on draft
// PR #42, and a prepare-review reply (at `review`, one that holds a review
// bundle). Each lens and the aggregator are
// scripted by their launch's name, so they may start in any order.
import fs from "node:fs";
import path from "node:path";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  flagValue,
  logOf,
  piStarts,
  repliesAt,
  runJob,
  setUp,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";
import { claimAt } from "./workflow-stages-fixtures.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const PR = 42;
// The head prepare-review prepares, and its changes' patch id.
const HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_LENGTH = 40;
const PATCH_ID = "f".repeat(SHA_LENGTH);
// The head the checks verified, which acceptance judges.
const VERIFIED = "e".repeat(SHA_LENGTH);
// The findings the issue numbered before: the next one is f3.
const NEXT_FINDING_ID = 2;
const BUNDLE_TEXT =
  "Review bundle of #7: the reviewed commits, the diff and src/a.ts at the head.";
const LENS_NAMES = ["correctness", "tests", "scope"];
const SESSION_FILE = /^i\d+-(?<name>.+)-\d+\.jsonl$/u;

/** @param {"blocking" | "nit"} severity @param {string} title @returns {object} a lens's finding */
function finding(severity, title) {
  return {
    severity,
    file: "src/a.ts",
    line: 3,
    title,
    evidence: "It returns null on an empty list.",
    suggestion: "Return 0.",
  };
}

/** @param {readonly object[]} findings @returns {object[]} a lens session that replies them */
function lensReplying(findings) {
  return [messageEnd(USAGE), outputEnd({ findings })];
}

// Three lenses with no blocking finding; correctness has a nit.
const CLEAN = {
  "review-correctness": lensReplying([finding("nit", "Name it plainly")]),
  "review-tests": lensReplying([]),
  "review-scope": lensReplying([]),
};

/**
 * Runs the stage job at `review` with `sessions` scripted by launch name,
 * `prepared` replacing fields of prepare-review's reply, and `script`
 * adding fields to the fake pi's script (such as `rejectPrompt`).
 * @param {Record<string, readonly object[]>} sessions
 * @param {Record<string, unknown>} [prepared]
 * @param {Record<string, unknown>} [script]
 */
function reviewJob(sessions, prepared = {}, script = {}) {
  const claim = claimAt("review", {
    pr: PR,
    headSha: "aaaaaaa",
    plan: "Change src/a.ts and test it.",
    nextFindingId: NEXT_FINDING_ID,
  });
  const place = setUp(
    { ...repliesAt("review"), claim },
    { sessions, ...script },
  );
  return runAt(place, "review", {
    ...preparedAt(place, HEAD),
    bundlePath: path.join(place.root, "bundle.md"),
    bundleLines: 1,
    bundleText: BUNDLE_TEXT,
    ...prepared,
  });
}

/** @param {Place} place @param {string} headSha @returns {Record<string, unknown>} prepare-review's reply at `headSha`, with no bundle */
function preparedAt(place, headSha) {
  return {
    ok: true,
    headSha,
    headTree: "cccccccccccccccccccccccccccccccccccccccc",
    baseSha: "dddddddddddddddddddddddddddddddddddddddd",
    patchId: PATCH_ID,
    diffPath: path.join(place.root, "diff.patch"),
    diffLines: "3",
    changedFiles: ["src/a.ts"],
  };
}

/**
 * Runs the stage job at `stage` with `prepared` as prepare-review's reply.
 * @param {Place} place
 * @param {string} stage
 * @param {Record<string, unknown>} prepared
 */
function runAt(place, stage, prepared) {
  const file = path.join(place.root, "replies.json");
  const replies = JSON.parse(fs.readFileSync(file, "utf8"));
  replies["prepare-review"] = prepared;
  fs.writeFileSync(file, JSON.stringify(replies));
  const r = runJob(place, ["--stage", stage]);
  return { place, r, ...outcomeOf(place, r.stdout) };
}

/**
 * Runs the stage job at `accept` (#423), the issue verified at VERIFIED
 * with `fields` added to its saved state, `sessions` scripted by launch
 * name, and `prepared` replacing fields of prepare-review's reply at the
 * verified head.
 * @param {Record<string, readonly object[]>} sessions
 * @param {Record<string, unknown>} [fields]
 * @param {Record<string, unknown>} [prepared]
 */
function acceptJob(sessions, fields = {}, prepared = {}) {
  const claim = claimAt("accept", {
    pr: PR,
    headSha: VERIFIED,
    verifiedSha: VERIFIED,
    verifySummary: "checks passed: npm test",
    plan: "Change src/a.ts and test it.",
    nextFindingId: NEXT_FINDING_ID,
    ...fields,
  });
  const place = setUp({ ...repliesAt("accept"), claim }, { sessions });
  return runAt(place, "accept", {
    ...preparedAt(place, VERIFIED),
    ...prepared,
  });
}

/** @param {Place} place @param {string} stdout */
function outcomeOf(place, stdout) {
  const ops = logOf(place, "ops.log");
  const [line] = stdout.trim().split("\n");
  const saves = ops.filter(({ op }) => op === "save-state");
  /** @type {{ at: number, number: number, by: { role: string }, body: string, key: string }[]} */
  const comments = [];
  for (const [at, { op, comments: posted }] of ops.entries()) {
    if (op === "post") {
      comments.push(...posted.map((/** @type {object} */ c) => ({ at, ...c })));
    }
  }
  return {
    ops,
    summary: JSON.parse(line ?? "null"),
    saved: saves.at(-1)?.state,
    comments,
    stops: ops.filter(({ op }) => op === "stop"),
    steps: statusOf(place)?.steps ?? [],
  };
}

/** @param {readonly string[]} argv @returns {string} the launch's name in its session file */
function launchName(argv) {
  const file = path.basename(flagValue(argv, "--session"));
  const { name = file } = SESSION_FILE.exec(file)?.groups ?? {};
  return name;
}

/** @param {Place} place @returns {Record<string, string>} each launch's model, by name */
function modelsOf(place) {
  return Object.fromEntries(
    piStarts(place).map(({ argv }) => [
      launchName(argv),
      flagValue(argv, "--model"),
    ]),
  );
}

/** @param {Place} place @returns {Record<string, string>} each launch's task, by name */
function tasksOf(place) {
  return Object.fromEntries(
    logOf(place, "pi.log")
      .filter(({ command }) => command?.type === "prompt")
      .map(({ command, name }) => [name, String(command.message)]),
  );
}

/** @param {readonly string[]} texts @returns {string} the text they all start with */
function commonPrefix(texts) {
  const [first = ""] = texts;
  let { length } = first;
  for (const text of texts) {
    let same = 0;
    while (same < length && text[same] === first[same]) {
      same += 1;
    }
    length = same;
  }
  return first.slice(0, length);
}

export {
  acceptJob,
  BUNDLE_TEXT,
  CLEAN,
  commonPrefix,
  finding,
  HEAD,
  LENS_NAMES,
  launchName,
  lensReplying,
  modelsOf,
  NEXT_FINDING_ID,
  PATCH_ID,
  PR,
  reviewJob,
  SHA_LENGTH,
  tasksOf,
  VERIFIED,
};
