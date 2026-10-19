// @ts-check
// A supported branch POST creates a genuine [P,H] commit on only its named ref.
import {
  branchHead,
  gitIn,
  gitSucceeds,
  issueOf,
} from "./pipeline-flow-gh-world.mjs";

/** @typedef {import("./pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./pipeline-flow-gh-world.mjs").Answer} Answer */
const REQUEST_ARGS = 8;
const FULL_HEAD = /^[0-9a-f]{40}$/u;
const CLOSES_ISSUE = /\bCloses #(?<issue>\d+)\b/gu;

/** @param {string} status @param {object | null} body @param {number} [code] @returns {Answer} */
function response(status, body, code = 0) {
  let text = "";
  if (body !== null) {
    text = JSON.stringify(body);
  }
  return { code, stdout: `HTTP/2.0 ${status}\r\n\r\n${text}` };
}

/** @param {World} world @param {readonly string[]} args @returns {{ base: string, head: string }} */
function mergeRequest(world, args) {
  const [
    endpoint,
    methodFlag,
    method,
    include,
    baseFlag,
    baseField,
    headFlag,
    headField,
  ] = args;
  const base = String(baseField).slice("base=".length);
  const head = String(headField).slice("head=".length);
  if (
    args.length !== REQUEST_ARGS ||
    endpoint !== `repos/${world.repo}/merges` ||
    methodFlag !== "--method" ||
    method !== "POST" ||
    include !== "--include" ||
    baseFlag !== "-f" ||
    headFlag !== "-f" ||
    baseField !== `base=${base}` ||
    headField !== `head=${head}` ||
    !FULL_HEAD.test(head)
  ) {
    throw new Error("fake-gh: unsupported branch merge arguments");
  }
  return { base, head };
}

/** @param {World} world @param {readonly string[]} args @returns {Answer} */
function branchMerge(world, args) {
  const { base, head } = mergeRequest(world, args);
  const change = world.prs.find(
    (pr) => pr.base === base && branchHead(world.origin, pr.head) === head,
  );
  const parent = branchHead(world.origin, base);
  if (change === undefined || parent === null) {
    return response(
      "404 Not Found",
      { message: "unknown source or target" },
      1,
    );
  }
  if (
    gitSucceeds(world.origin, ["merge-base", "--is-ancestor", head, parent])
  ) {
    return response("204 No Content", null);
  }
  const treeArgs = ["merge-tree", "--write-tree", parent, head];
  if (!gitSucceeds(world.origin, treeArgs)) {
    return response("409 Conflict", { message: "merge conflict" }, 1);
  }
  const [tree = ""] = gitIn(world.origin, treeArgs).split("\n");
  const sha = gitIn(world.origin, [
    "commit-tree",
    tree,
    "-p",
    parent,
    "-p",
    head,
    "-m",
    `Merge PR #${change.number}`,
  ]);
  gitIn(world.origin, ["update-ref", `refs/heads/${base}`, sha, parent]);
  Object.assign(change, { state: "MERGED", mergeOid: sha, mergedHead: head });
  issueOf(world, change.number).state = "closed";
  const defaultRef = gitIn(world.origin, ["symbolic-ref", "HEAD"]);
  if (defaultRef === `refs/heads/${base}`) {
    for (const match of change.body.matchAll(CLOSES_ISSUE)) {
      const { issue } = match.groups ?? {};
      Object.assign(issueOf(world, Number(issue)), {
        state: "closed",
        stateReason: "completed",
      });
    }
  }
  return response("201 Created", { sha });
}

export { branchMerge };
