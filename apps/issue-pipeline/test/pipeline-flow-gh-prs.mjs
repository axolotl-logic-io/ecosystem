// @ts-check
// PR views, history and lifecycle for the local fake GitHub.
import { viewOf } from "./pipeline-flow-gh-pr.mjs";
import {
  branchHead,
  flagValue,
  issueOf,
  jsonAnswer,
  now,
} from "./pipeline-flow-gh-world.mjs";

/** @typedef {import("./pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./pipeline-flow-gh-world.mjs").Answer} Answer */

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function createPr(world, args) {
  const number = world.nextId;
  world.nextId += 1;
  const title = String(flagValue(args, "--title"));
  world.prs.push({
    number,
    head: String(flagValue(args, "--head")),
    base: String(flagValue(args, "--base")),
    title,
    body: flagValue(args, "--body") ?? "",
    state: "OPEN",
    isDraft: args.includes("--draft"),
    mergeOid: null,
    mergedHead: null,
  });
  const login = "dev-bot";
  const at = now();
  /** @type {import("./pipeline-flow-gh-world.mjs").FlowIssue} */
  const kept = {
    number,
    title,
    body: "",
    login,
    state: "open",
    createdAt: at,
    stateReason: null,
    labels: [],
    isPull: true,
  };
  world.issues.push(kept);
  return { stdout: `https://github.com/${world.repo}/pull/${number}\n` };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function listPrs(world, args) {
  const head = flagValue(args, "--head");
  const state = (flagValue(args, "--state") ?? "open").toUpperCase();
  const fields = flagValue(args, "--json");
  const rows = world.prs
    .filter((item) => head === null || item.head === head)
    .filter((item) => state === "ALL" || item.state === state)
    .map((item) =>
      JSON.parse(String(jsonAnswer(viewOf(world, item), fields).stdout)),
    );
  return { stdout: `${JSON.stringify(rows)}\n` };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function pr(world, args) {
  const [, sub, target] = args;
  if (sub === "create") {
    return createPr(world, args);
  }
  if (sub === "list") {
    return listPrs(world, args);
  }
  const change = world.prs.find((item) => item.number === Number(target));
  if (change === undefined) {
    return { code: 1, stderr: `no pull requests found for ${target}` };
  }
  switch (sub) {
    case "view": {
      const view = viewOf(world, change);
      if (world.withholdMergeBinding && change.state === "MERGED") {
        Object.assign(view, { state: "CLOSED", mergeCommit: null });
      }
      return jsonAnswer(view, flagValue(args, "--json"));
    }
    case "checks": {
      const link = `https://github.com/${world.repo}/actions/runs/1/job/1`;
      let state = "SUCCESS";
      let bucket = "pass";
      if (world.failedHead === branchHead(world.origin, change.head)) {
        state = "FAILURE";
        bucket = "fail";
      }
      const check = { name: "test", state, bucket, link };
      return { stdout: `${JSON.stringify([check])}\n` };
    }
    case "edit":
      change.body = flagValue(args, "--body") ?? change.body;
      return { stdout: "" };
    case "ready":
      change.isDraft = false;
      return { stdout: "" };
    case "close":
      change.closedHead = branchHead(world.origin, change.head);
      change.state = "CLOSED";
      issueOf(world, change.number).state = "closed";
      return { stdout: "" };
    default:
      throw new Error(`fake-gh: unsupported pr ${sub}`);
  }
}

export { pr };
