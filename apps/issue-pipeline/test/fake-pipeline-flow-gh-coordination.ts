// The fake GitHub's git-data routes the coordination transport uses
// (src/execution.ts, #167): reading a ref, making a commit from a tree and
// its parents, reading a commit, and creating a ref only when it doesn't
// exist. Commits are real objects in the bare origin. The epoch refs the
// transport reserves live in the world's `refs`, so a test that restores a
// world snapshot restores them too; any other ref, such as the base, is the
// origin's.
import fs from "node:fs";
import type { Answer, World } from "./fake-pipeline-flow-gh-world.ts";
import { gitIn, gitSucceeds } from "./fake-pipeline-flow-gh-world.ts";

const NOT_FOUND = { code: 1, stderr: "HTTP 404: Not Found" };

// Returns the call's `--input -` body, which the route says the shape of
function inputOf<Input>(): Input {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function refOf(world: World, ref: string): string | null {
  const reserved = world.refs?.[ref];
  if (reserved !== undefined) {
    return reserved;
  }
  if (!gitSucceeds(world.origin, ["rev-parse", "--verify", ref])) {
    return null;
  }
  return gitIn(world.origin, ["rev-parse", ref]);
}

function commitOf(world: World, sha: string): Answer {
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

// Answers a coordination git-data call, its route after repos/<owner>/<repo>/.
function coordinationGit(
  world: World,
  call: { method: string; route: string[] },
): Answer {
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
    const { message, tree, parents } = inputOf<{
      message: string;
      tree: string;
      parents: string[];
    }>();
    const parentArgs = parents.flatMap((p) => ["-p", p]);
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
    const { ref, sha } = inputOf<{ ref: string; sha: string }>();
    if (refOf(world, ref) !== null) {
      return { code: 1, stderr: "HTTP 422: Reference already exists" };
    }
    world.refs = { ...world.refs, [ref]: sha };
    return { stdout: `${JSON.stringify({ ref, object: { sha } })}\n` };
  }
  throw new Error(`fake-gh: unsupported api git/${second}`);
}

export { coordinationGit };
