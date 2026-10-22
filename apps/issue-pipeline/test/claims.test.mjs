// @ts-check
// liveClaims from ops.mjs: which comments count as a lane's claim on an issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFixture } from "./config-fixtures.mjs";
import { claimComment, githubComment } from "./fake-gh.mjs";
import "./isolated-root-test-kit.mjs";

/** @import { IssueComment } from "../src/comments.ts" */

const { liveClaims } = await import("../src/claims.ts");
const { COMMENT } = await import("../src/comments.ts");

const cfg = configFixture();
const now = new Date().toISOString();
const MS_PER_HOUR = 3_600_000;
// Past the config's three-hour lease.
const EXPIRED_HOURS = 4;

/** @param {string} lane @returns {string} */
function claimBody(lane) {
  return claimComment({ id: 1, lane, sweep: "s1", login: "bot", at: now }).body;
}

/** @param {number} id @param {string} body @param {string} [login] @param {string} [at] @returns {IssueComment} */
function comment(id, body, login = "bot", at = now) {
  return COMMENT.parse(
    githubComment({ id, body, login, created: at, updated: at }),
  );
}

test("a claim the pipeline posted counts", () => {
  assert.deepEqual(
    liveClaims(cfg, [
      comment(2, claimBody("b")),
      comment(1, claimBody("a")),
    ]).map((c) => c.lane),
    ["a", "b"],
  );
});

test("a person quoting the claim marker from the same account doesn't count (#120)", () => {
  const quoted =
    "The claim format is `<!-- agent-pipeline:claim lane=<lane> sweep=<sweep> -->`.";
  assert.deepEqual(
    liveClaims(cfg, [comment(1, quoted), comment(2, claimBody("b"))]).map(
      (c) => c.lane,
    ),
    ["b"],
  );
});

test("a pipeline comment of another role carrying the claim marker doesn't count", () => {
  const body = claimBody("a").replace("role=claim", "role=coordinator");
  assert.deepEqual(liveClaims(cfg, [comment(1, body)]), []);
});

test("a claim from another account doesn't count", () => {
  assert.deepEqual(
    liveClaims(cfg, [comment(1, claimBody("a"), "visitor")]),
    [],
  );
});

test("a claim not edited for leaseHours has expired", () => {
  const old = new Date(Date.now() - EXPIRED_HOURS * MS_PER_HOUR).toISOString();
  assert.deepEqual(
    liveClaims(cfg, [comment(1, claimBody("a"), "bot", old)]),
    [],
  );
});

test("a closed claim doesn't count", () => {
  const closed = claimBody("a").replace(
    "agent-pipeline:claim lane",
    "agent-pipeline:claim-closed lane",
  );
  assert.deepEqual(liveClaims(cfg, [comment(1, closed)]), []);
});
