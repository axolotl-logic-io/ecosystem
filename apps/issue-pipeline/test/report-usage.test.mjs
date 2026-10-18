// @ts-check
// The usage report (#302, src/report/usage.ts): nearest-rank spreads per
// role, state and model, the four flags, each role's top tools, and the
// records it leaves out: another account's comments and records before
// --since.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { COMMENT } from "../src/comments.ts";
import { loadConfig } from "../src/config.ts";
import { usageBody } from "../src/job/usage-comment.ts";
import { serializeUsage } from "../src/job/usage-log.ts";
import { OpsError } from "../src/process.ts";
import { usageReport } from "../src/report/usage.ts";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.mjs";
import { sessionRecord } from "./usage-fixtures.mjs";

/** @import { IssueComment } from "../src/comments.ts" */
/** @import { ReportOptions, UsageFlags } from "../src/report/usage.ts" */

const ACCOUNT = "a";
const ISSUE = 7;
const COMMENT_ID = 41;
const START = Date.parse("2026-10-16T12:00:00.000Z");
const MINUTE = 60_000;
const CREATED = "2026-10-16T13:00:00Z";
/** @type {ReportOptions} */
const OPTIONS = { account: ACCOUNT, role: null, issue: null, since: null };
/** @type {UsageFlags} */
const FLAGS = { firstContext: 40_000, toolOutputShare: 0.25 };
const REPORT = new URL("../src/report.ts", import.meta.url).pathname;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-report-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let files = 0;
// --since as given, and the time the listing asks GitHub for.
const SINCE = "2026-10-01";
const SINCE_TIME = "2026-10-01T00:00:00.000Z";
// A tool share past the whole peak.
const PAST_WHOLE = 1.5;

// The fixture session's context: its first turn, peak and last turn, under
// the soft limit of 150,000 tokens.
const FIRST = 1200;
const PEAK = 5300;
const AT_FINISH = 5000;

/** @param {number} minute @returns {string} a record time, `minute`s on */
function atOf(minute) {
  return new Date(START + minute * MINUTE).toISOString();
}

/**
 * The fixture session's context, with `first` and `peak` replaced.
 * @param {{ first?: number, peak?: number }} over
 * @returns {object}
 */
function contextWith({ first = FIRST, peak = PEAK }) {
  return {
    first,
    peak,
    atFinish: AT_FINISH,
    soft: 150_000,
    hard: 175_000,
    window: null,
    steered: false,
  };
}

/**
 * A session record's line, at `minute`, with `over` on top.
 * @param {number} minute
 * @param {Record<string, unknown>} [over]
 * @returns {string}
 */
function lineAt(minute, over = {}) {
  return serializeUsage(sessionRecord({ at: atOf(minute), ...over }));
}

/**
 * Session record lines, a minute apart, each with its `over` on top.
 * @param {readonly Record<string, unknown>[]} overs
 * @returns {string[]}
 */
function linesOf(overs) {
  return overs.map((over, minute) => lineAt(minute, over));
}

/**
 * A usage comment holding `lines`, as listComments parses it.
 * @param {readonly string[]} lines
 * @param {string} [login]
 * @returns {IssueComment}
 */
function usageComment(lines, login = ACCOUNT) {
  const body = usageBody(ISSUE, 1, lines);
  return COMMENT.parse(
    githubComment({ id: COMMENT_ID, body, login, created: CREATED }),
  );
}

// Ten peaks, 1000 to 10000, out of order: step 3 through the ten ranks.
const SESSIONS = 10;
const STRIDE = 3;
const THOUSAND = 1000;
const PEAKS = Array.from(
  { length: SESSIONS },
  (_, i) => (((i * STRIDE) % SESSIONS) + 1) * THOUSAND,
);

test("the spreads are by nearest rank: median 5000, p90 9000, max 10000 of ten", () => {
  const lines = linesOf(
    PEAKS.map((peak) => ({ context: contextWith({ peak }) })),
  );
  const { groups } = usageReport([usageComment(lines)], OPTIONS, FLAGS);
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group?.count, PEAKS.length);
  assert.deepEqual(group?.peak, { median: 5000, p90: 9000, max: 10_000 });
});

test("each flag is raised by the session that crosses it, and only that one", () => {
  const lines = linesOf([
    { state: "calm" },
    { state: "first", context: contextWith({ first: 41_000, peak: 50_000 }) },
    { state: "soft", context: contextWith({ peak: 160_000 }) },
    { state: "tools", largestToolOutput: { tool: "read", chars: 2000 } },
    { state: "work", attempt: 1 },
    { state: "work", attempt: 2, context: contextWith({ first: 2000 }) },
  ]);
  const { flagged } = usageReport([usageComment(lines)], OPTIONS, FLAGS);
  assert.deepEqual(
    flagged.map(({ state, attempt, reasons }) => ({ state, attempt, reasons })),
    [
      { state: "first", attempt: 1, reasons: ["first-context"] },
      { state: "soft", attempt: 1, reasons: ["past-soft"] },
      { state: "tools", attempt: 1, reasons: ["tool-output"] },
      { state: "work", attempt: 2, reasons: ["first-grew"] },
    ],
  );
});

test("another account's marked comment adds to no group and no flag", () => {
  const mine = usageComment([lineAt(0)]);
  const forged = usageComment(
    [lineAt(1, { context: contextWith({ first: 41_000, peak: 160_000 }) })],
    "mallory",
  );
  const report = usageReport([mine, forged], OPTIONS, FLAGS);
  assert.deepEqual(report, usageReport([mine], OPTIONS, FLAGS));
  assert.equal(report.groups[0]?.count, 1);
  assert.deepEqual(report.flagged, []);
});

test("a record from before --since is left out", () => {
  const since = atOf(1);
  const lines = linesOf([{ context: contextWith({ peak: 160_000 }) }, {}]);
  const report = usageReport(
    [usageComment(lines)],
    { ...OPTIONS, since },
    FLAGS,
  );
  assert.equal(report.groups[0]?.count, 1);
  assert.equal(report.groups[0]?.peak.max, PEAK);
  assert.deepEqual(report.flagged, []);
});

test("each role lists the five tools with the most output", () => {
  const lines = linesOf([
    {
      tools: {
        read: { calls: 1, outputChars: 600 },
        bash: { calls: 1, outputChars: 500 },
        grep: { calls: 1, outputChars: 400 },
        edit: { calls: 1, outputChars: 300 },
        write: { calls: 1, outputChars: 200 },
        find: { calls: 1, outputChars: 100 },
      },
    },
    { tools: { find: { calls: 1, outputChars: 650 } } },
  ]);
  const { tools } = usageReport([usageComment(lines)], OPTIONS, FLAGS);
  assert.deepEqual(tools, [
    {
      role: "implementor",
      top: [
        { tool: "find", calls: 2, outputChars: 750 },
        { tool: "read", calls: 1, outputChars: 600 },
        { tool: "bash", calls: 1, outputChars: 500 },
        { tool: "grep", calls: 1, outputChars: 400 },
        { tool: "edit", calls: 1, outputChars: 300 },
      ],
    },
  ]);
});

/** @param {object} extra @returns {string} a repo config file with `extra` */
function configWith(extra) {
  files += 1;
  const file = path.join(tmp, `config-${files}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo: "o/r",
      account: ACCOUNT,
      allowedUsers: [ACCOUNT],
      commands: { test: "true" },
      ...extra,
    }),
  );
  return file;
}

// Whether loading a config with `extra` throws an OpsError naming its file.
/** @param {object} extra @returns {boolean} */
function refuses(extra) {
  const file = configWith(extra);
  try {
    loadConfig(file);
  } catch (err) {
    return err instanceof OpsError && err.message.includes(file);
  }
  return false;
}

test("report usage --since reads the comments in one paged since listing", () => {
  const gh = installFakeGh();
  const comment = githubComment({
    id: COMMENT_ID,
    body: usageBody(ISSUE, 1, linesOf([{}])),
    login: ACCOUNT,
    created: CREATED,
  });
  gh.reply([
    { when: "issues/comments?per_page", stdout: commentLines([comment]) },
  ]);
  const { PATH: searchPath } = process.env;
  const env = new Map([
    ["ISSUE_PIPELINE_ROOT", tmp],
    ["PATH", searchPath],
  ]);
  const args = ["usage", "--config", configWith({}), "--since", SINCE];
  const r = spawnSync(process.execPath, [REPORT, ...args], {
    encoding: "utf8",
    env: Object.fromEntries(env),
  });
  assert.equal(r.status, 0, r.stderr);
  const listings = gh
    .calls()
    .filter((call) => call.some((arg) => arg.includes("issues/comments")));
  assert.equal(listings.length, 1);
  const [listing = []] = listings;
  assert.ok(listing.includes("--paginate"));
  assert.ok(
    listing.includes(
      `repos/o/r/issues/comments?per_page=100&since=${SINCE_TIME}`,
    ),
  );
});

test("usageFlags default to 40000 first-turn tokens and a 0.25 tool share", () => {
  assert.deepEqual(loadConfig(configWith({})).usageFlags, FLAGS);
});

test("a tool share of 0 or past 1 throws naming the config file; 1 is kept", () => {
  for (const toolOutputShare of [0, PAST_WHOLE]) {
    const usageFlags = { ...FLAGS, toolOutputShare };
    assert.ok(refuses({ usageFlags }), String(toolOutputShare));
  }
  const whole = { ...FLAGS, toolOutputShare: 1 };
  const cfg = loadConfig(configWith({ usageFlags: whole }));
  assert.deepEqual(cfg.usageFlags, whole);
});
