// Whether a branch changes code since a commit, as the implementor judges
// its work done (the wiki's Pipeline-Roles-Implementor, "Locate"): any file
// but the spec draft counts.

import { run } from "../../process.ts";
import { SPEC_DRAFT } from "../../spec-draft.ts";

// Whether the checkout at `dir` changes code at `head` since `sha`, the spec
// draft aside; undefined when git can't tell, such as for a sha it lacks.
function codeChangedSince(
  dir: string,
  sha: string,
  head: string,
): boolean | undefined {
  const args = ["-C", dir, "diff", "--name-only", sha, head, "--"];
  const result = run("git", args, { allowFail: true });
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout
    .split("\n")
    .some((file) => file !== "" && file !== SPEC_DRAFT);
}

export { codeChangedSince };
