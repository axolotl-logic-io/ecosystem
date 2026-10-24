// @ts-check
// The fake GitHub's git-data routes the coordination transport uses
// (src/execution.ts, #167): reading a ref, making a commit from a tree and
// its parents, reading a commit, and creating a ref only when it doesn't
// exist. Commits are real objects in the bare origin. The epoch refs the
// transport reserves live in the world's `refs`, so a test that restores a
// world snapshot restores them too; any other ref, such as the base, is the
// origin's.
import fs from "node:fs";
import { gitIn, gitSucceeds } from "./fake-pipeline-flow-gh-world.mjs";

/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").World} World */
/** @typedef {import("./fake-pipeline-flow-gh-world.mjs").Answer} Answer */

const NOT_FOUND = { code: 1, stderr: "HTTP 404: Not Found" };

/** @returns {any} the call's `--input -` body */
function inputOf() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

/** @param {World} world @param {string} ref @returns {string | null} */
function refOf(world, ref) {
  const reserved = world.refs?.[ref];
  if (reserved !== undefined) {
    return reserved;
  }
  if (!gitSucceeds(world.origin, ["rev-parse", "--verify", ref])) {
    return null;
  }
  return gitIn(world.origin, ["rev-parse", ref]);
}

/** @param {World} world @param {string} sha @returns {Answer} */
function commitOf(world, sha) {
  const tree = `${sha}^{tree}`;
  if (!gitSucceeds(world.origin, ["rev-parse", "--verify", tree])) {
    return NOT_FOUND;
  }
  const answer = {
    sha,
    tree: { sha: gitIn(world.origin, ["rev-parse", tree]) },
  };
  return { stdout: `${JSON.stringify(answer)}\n` };
}

/**
 * Answers a coordination git-data call, its route after repos/<owner>/<repo>/.
 * @param {World} world
 * @param {{ method: string, route: string[] }} call
 * @returns {Answer}
 */
function coordinationGit(world, call) {
  const [, second, ...rest] = call.route;
  const name = rest.join("/");
  if (second === "ref" && call.method === "GET") {
    const sha = refOf(world, `refs/${name}`);
    if (sha === null) {
      return NOT_FOUND;
    }
    return { stdout: `${JSON.stringify({ object: { sha } })}\n` };
  }
  if (second === "commits" && call.method === "GET") {
    return commitOf(world, name);
  }
  if (second === "commits" && call.method === "POST") {
    const { message, tree, parents } = inputOf();
    const parentArgs = parents.flatMap((/** @type {string} */ p) => ["-p", p]);
    const sha = gitIn(world.origin, [
      "commit-tree",
      tree,
      ...parentArgs,
      "-m",
      message,
    ]);
    return commitOf(world, sha);
  }
  if (second === "refs" && call.method === "POST") {
    const { ref, sha } = inputOf();
    if (refOf(world, ref) !== null) {
      return { code: 1, stderr: "HTTP 422: Reference already exists" };
    }
    world.refs = { ...world.refs, [ref]: sha };
    return { stdout: `${JSON.stringify({ ref, object: { sha } })}\n` };
  }
  throw new Error(`fake-gh: unsupported api git/${second}`);
}

export { coordinationGit };
