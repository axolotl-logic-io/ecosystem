// @ts-check
// Exact supported GitHub calls for the private explicit-target fixture.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  BRANCH,
  HOME,
  ISSUE,
  ISSUE_DATA,
  PR,
  REPO,
} from "./explicit-target-world-test-kit.mjs";

/** @typedef {import("./explicit-target-world-test-kit.mjs").World} World */
/** @typedef {{args: string[], stdout?: string, stderr?: string, code?: number, updates?: [string, string][]}} GhStep */
const CALLS = z.array(z.array(z.string()));
const REMAINING = z.object({ steps: z.array(z.unknown()) });
const VIEW_FIELDS =
  "number,isCrossRepository,baseRefName,headRefName,headRefOid,state,mergeable,mergeStateStatus,isDraft,mergeCommit";
const RECEIPT_FIELDS =
  "number,state,mergeCommit,headRefName,headRefOid,baseRefName,isCrossRepository";

/** @param {World} w @param {Record<string, unknown>} [extra] */
function view(w, extra = {}) {
  return {
    number: PR,
    state: "OPEN",
    headRefName: BRANCH,
    headRefOid: w.head,
    baseRefName: w.cfg.baseBranch,
    isCrossRepository: false,
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    ...extra,
  };
}
/** @param {World} w @param {Record<string, unknown>} [extra] @param {boolean} [receipt] @returns {GhStep} */
function prStep(w, extra = {}, receipt = false) {
  let fields = VIEW_FIELDS;
  if (receipt) {
    fields = RECEIPT_FIELDS;
  }
  return {
    args: ["pr", "view", String(PR), "-R", REPO, "--json", fields],
    stdout: JSON.stringify(view(w, extra)),
  };
}
/** @param {World} w @returns {GhStep[]} */
function prechecks(w) {
  return [
    prStep(w),
    {
      args: ["api", `repos/${REPO}/issues/${ISSUE}`],
      stdout: JSON.stringify(ISSUE_DATA),
    },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    {
      args: [
        "api",
        "--paginate",
        `repos/${REPO}/issues/${ISSUE}/comments?per_page=100`,
        "--jq",
        ".[] | @json",
      ],
    },
    { args: ["api", `repos/${REPO}/collaborators/owner`, "--silent"] },
    prStep(w, {}, true),
    prStep(w),
    {
      args: [
        "api",
        `repos/${REPO}/pulls/${PR}/reviews`,
        "--method",
        "POST",
        "-f",
        "event=APPROVE",
        "-f",
        `commit_id=${w.head}`,
        "--jq",
        "{state, commit: .commit_id, login: .user.login}",
      ],
      stdout: JSON.stringify({
        state: "APPROVED",
        commit: w.head,
        login: w.cfg.mergeAccount,
      }),
    },
  ];
}
/** @param {World} w @param {Partial<GhStep>} [extra] @returns {GhStep} */
function post(w, extra = {}) {
  return {
    args: [
      "api",
      `repos/${REPO}/merges`,
      "--method",
      "POST",
      "--include",
      "-f",
      `base=${w.cfg.baseBranch}`,
      "-f",
      `head=${w.head}`,
    ],
    stdout: `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ sha: w.merged })}`,
    updates: [[`refs/heads/${w.cfg.baseBranch}`, w.merged]],
    ...extra,
  };
}
/** @param {World} w @returns {Record<string, unknown>} */
function mergedView(w) {
  return { state: "MERGED", mergeCommit: { oid: w.merged } };
}
/** @param {World} w @param {GhStep[]} steps @returns {void} */
function script(w, steps) {
  fs.writeFileSync(
    path.join(HOME, "gh-script.json"),
    JSON.stringify({ origin: w.origin, steps }),
  );
  fs.writeFileSync(path.join(HOME, "gh-calls.jsonl"), "");
}
/** @returns {string[][]} */
function calls() {
  const text = fs
    .readFileSync(path.join(HOME, "gh-calls.jsonl"), "utf8")
    .trim();
  if (text === "") {
    return [];
  }
  return CALLS.parse(text.split("\n").map((line) => JSON.parse(line)));
}
/** @returns {void} */
function consumed() {
  const remaining = REMAINING.parse(
    JSON.parse(fs.readFileSync(path.join(HOME, "gh-script.json"), "utf8")),
  );
  if (remaining.steps.length > 0) {
    throw new Error("not all explicitly supported gh calls were consumed");
  }
}
/** @param {World} w */
function request(w) {
  return {
    number: ISSUE,
    state: w.state,
    revision: w.revision,
    expectedSha: w.head,
    mergeQueue: null,
  };
}

export {
  calls,
  consumed,
  mergedView,
  post,
  prechecks,
  prStep,
  request,
  script,
  view,
};
