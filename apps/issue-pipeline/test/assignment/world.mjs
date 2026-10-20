// @ts-check

import { ASSIGNMENT } from "../../src/assignment/schema.ts";
import { configFixture } from "../config-fixtures.mjs";

/** @import { IssueState } from '../../src/state.ts' */
/** @import { Execution } from '../../src/assignment/schema.ts' */
/** @import { IssueRow, Pull, Event, Review } from '../../src/assignment/signal-schema.ts' */
const SHA_LENGTH = 40;
const CODE = "a".repeat(SHA_LENGTH);
const TREE = "b".repeat(SHA_LENGTH);
const WIKI = "c".repeat(SHA_LENGTH);
const START = Date.parse("2026-10-20T00:00:00.000Z");
/** @param {string} [repo] */
function assignmentConfig(repo = "o/r") {
  return configFixture({
    repo,
    devAccount: "builder",
    mergeAccount: "merger",
    assignment: ASSIGNMENT.parse({
      enabled: true,
      workers: [
        { id: "build", login: "builder", roles: "development" },
        { id: "check", login: "merger", roles: "review" },
      ],
      pollSeconds: 10,
      maxBackoffSeconds: 60,
      heartbeatSeconds: 10,
      pageBudget: 3,
    }),
  });
}
/** @param {ReturnType<typeof assignmentConfig>} cfg */
function fakeWorld(cfg) {
  return {
    cfg,
    issues: new Map(/** @type {[number, IssueRow][]} */ ([])),
    states: new Map(/** @type {[number, IssueState][]} */ ([])),
    events: new Map(/** @type {[number, Event[]][]} */ ([])),
    prs: new Map(/** @type {[number, Pull][]} */ ([])),
    reviews: new Map(/** @type {[number, Review[]][]} */ ([])),
    refs: new Map([[`heads/${cfg.baseBranch}`, CODE]]),
    commits: new Map([
      [CODE, { sha: CODE, tree: { sha: TREE }, message: "base" }],
    ]),
    notices: new Map(/** @type {[number, string][]} */ ([])),
    allowed: new Set(["alice"]),
    launches: /** @type {Execution[]} */ ([]),
    reads: /** @type {string[]} */ ([]),
    writes: /** @type {string[]} */ ([]),
    world: {
      now: START,
      inputs: "inputs-1",
      failRequest: false,
      scope: true,
      sequence: 1000,
    },
  };
}

/** @typedef {ReturnType<typeof fakeWorld>} World */
export { assignmentConfig, CODE, fakeWorld, SHA_LENGTH, START, TREE, WIKI };
