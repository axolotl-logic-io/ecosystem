// @ts-check
// The fake GitHub's entry and its `gh pr`, `gh issue` and `gh label`
// commands. A PR's head is read from the bare origin when GitHub is asked;
// its squash merge is a real commit on the base whose parent is the base
// and whose tree merges the head onto it, refused unless the head is still
// `--match-head-commit`'s. Every PR has one required check, which passes.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { api } from "./pipeline-flow-gh-api.mjs";
import {
  branchHead,
  flagValue,
  gitIn,
  gitSucceeds,
  issueOf,
  jsonAnswer,
  now,
  postComment,
  withWorld,
} from "./pipeline-flow-gh-world.mjs";

/** @typedef {import("./pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./pipeline-flow-gh-world.mjs").FlowPr} FlowPr */
/** @typedef {import("./pipeline-flow-gh-world.mjs").Answer} Answer */

const UNSUPPORTED = "fake-gh: unsupported";
const NOT_MERGEABLE = "GraphQL: Pull request is not mergeable";

/**
 * GitHub's mergeability of an open PR: clean on the base, behind it, or
 * conflicting with it.
 * @param {World} world @param {FlowPr} change @param {string | null} head
 */
function mergeability(world, change, head) {
  const base = branchHead(world.origin, change.base);
  const clean = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
  if (change.state !== "OPEN" || head === null || base === null) {
    return clean;
  }
  if (gitSucceeds(world.origin, ["merge-base", "--is-ancestor", base, head])) {
    return clean;
  }
  const tree = ["merge-tree", "--write-tree", base, head];
  if (gitSucceeds(world.origin, tree)) {
    return { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" };
  }
  return { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
}

/**
 * The PR as `gh pr view --json` shows it.
 * @param {World} world @param {FlowPr} change @returns {Record<string, unknown>}
 */
function viewOf(world, change) {
  const live = branchHead(world.origin, change.head);
  let mergeCommit = null;
  if (change.mergeOid !== null) {
    mergeCommit = { oid: change.mergeOid };
  }
  return {
    number: change.number,
    state: change.state,
    title: change.title,
    body: change.body,
    headRefName: change.head,
    headRefOid: change.mergedHead ?? live ?? "",
    baseRefName: change.base,
    isCrossRepository: false,
    isDraft: change.isDraft,
    mergeCommit,
    ...mergeability(world, change, live),
  };
}

/**
 * Squash-merges `change` at `expected`, or refuses as GitHub does.
 * @param {World} world @param {FlowPr} change @param {string | null} expected
 * @returns {Answer}
 */
function squash(world, change, expected) {
  const head = branchHead(world.origin, change.head);
  const base = branchHead(world.origin, change.base);
  if (
    change.state !== "OPEN" ||
    change.isDraft ||
    head === null ||
    base === null
  ) {
    return { code: 1, stderr: NOT_MERGEABLE };
  }
  if (head !== expected) {
    return {
      code: 1,
      stderr:
        "GraphQL: Head branch was modified. Review and try the merge again.",
    };
  }
  const tree = ["merge-tree", "--write-tree", base, head];
  if (!gitSucceeds(world.origin, tree)) {
    return { code: 1, stderr: NOT_MERGEABLE };
  }
  const [treeId = ""] = gitIn(world.origin, tree).split("\n");
  const message = `${change.title} (#${change.number})`;
  const commit = gitIn(world.origin, [
    "commit-tree",
    treeId,
    "-p",
    base,
    "-m",
    message,
  ]);
  gitIn(world.origin, [
    "update-ref",
    `refs/heads/${change.base}`,
    commit,
    base,
  ]);
  Object.assign(change, {
    state: "MERGED",
    mergeOid: commit,
    mergedHead: head,
  });
  issueOf(world, change.number).state = "closed";
  return { stdout: "" };
}

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
  const login = world.account;
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
    case "view":
      return jsonAnswer(viewOf(world, change), flagValue(args, "--json"));
    case "checks": {
      const link = `https://github.com/${world.repo}/actions/runs/1/job/1`;
      const check = { name: "test", state: "SUCCESS", bucket: "pass", link };
      return { stdout: `${JSON.stringify([check])}\n` };
    }
    case "edit":
      change.body = flagValue(args, "--body") ?? change.body;
      return { stdout: "" };
    case "ready":
      change.isDraft = false;
      return { stdout: "" };
    case "close":
      change.state = "CLOSED";
      issueOf(world, change.number).state = "closed";
      return { stdout: "" };
    case "merge":
      return squash(world, change, flagValue(args, "--match-head-commit"));
    default:
      throw new Error(`${UNSUPPORTED} pr ${sub}`);
  }
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function issueCommand(world, args) {
  const [, sub, target] = args;
  if (sub === "list") {
    const wanted = flagValue(args, "--label");
    const rows = world.issues
      .filter((each) => each.state === "open" && each.isPull !== true)
      .filter((each) => wanted === null || each.labels.includes(wanted))
      .map((each) => ({
        number: each.number,
        title: each.title,
        body: each.body,
        author: { login: each.login },
        labels: each.labels.map((name) => ({ name })),
        createdAt: each.createdAt,
      }));
    return { stdout: `${JSON.stringify(rows)}\n` };
  }
  const item = issueOf(world, Number(String(target).replace("#", "")));
  if (sub === "view") {
    const labels = item.labels.map((name) => ({ name }));
    const view = { state: item.state.toUpperCase(), labels, title: item.title };
    return jsonAnswer(view, flagValue(args, "--json"));
  }
  if (sub !== "close") {
    throw new Error(`${UNSUPPORTED} issue ${sub}`);
  }
  const reason = flagValue(args, "--reason") ?? "completed";
  Object.assign(item, { state: "closed", stateReason: reason });
  const said = flagValue(args, "--comment");
  if (said !== null) {
    postComment(world, item.number, world.account, said);
  }
  return { stdout: "" };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function labelCommand(world, args) {
  const [, sub, name] = args;
  if (sub === "list") {
    const rows = world.repoLabels.map((each) => ({ name: each }));
    return { stdout: `${JSON.stringify(rows)}\n` };
  }
  if (sub !== "create") {
    throw new Error(`${UNSUPPORTED} label ${sub}`);
  }
  world.repoLabels = [...new Set([...world.repoLabels, String(name)])];
  return { stdout: "" };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function answer(world, args) {
  switch (args[0]) {
    case "api":
      return api(world, args.slice(1));
    case "pr":
      return pr(world, args);
    case "issue":
      return issueCommand(world, args);
    case "label":
      return labelCommand(world, args);
    default:
      throw new Error(`${UNSUPPORTED} command ${args[0]}`);
  }
}

/**
 * The fake gh's entry: logs the call, answers it from the world and exits;
 * an unsupported call is also kept in the world for the test to see.
 * @param {string} dir
 */
function runFlowGh(dir) {
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "calls.jsonl"), `${JSON.stringify(args)}\n`);
  /** @type {Answer} */
  let reply = {};
  try {
    reply = withWorld(dir, (world) => answer(world, args));
  } catch (error) {
    const message = String(error);
    if (message.includes(UNSUPPORTED)) {
      withWorld(dir, (world) => world.unsupported.push(args));
    }
    reply = { code: 1, stderr: `${message}\n` };
  }
  process.stdout.write(reply.stdout ?? "");
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
}

export { runFlowGh };
