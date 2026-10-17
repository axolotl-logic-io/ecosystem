// A checkout's uncommitted changes saved as a patch before a stage job drops
// them (dropped-changes-saved, #369). The patch is inert: a header that
// names what it is and its base commit, then git's binary-safe diff of
// everything uncommitted (staged, unstaged and untracked, less ignored
// files) against HEAD, written byte for byte, so `git apply --index` on a
// checkout of the base recreates every file. Nothing here applies one.

import fs from "node:fs";
import path from "node:path";
import { run } from "../process.ts";

// `git diff --quiet` exits 1 when there is a difference.
const DIFFERS = 1;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// True when the index of `dir` differs from its HEAD.
function stagedDiffers(dir: string): boolean {
  const args = ["-C", dir, "diff", "--cached", "--quiet", "HEAD"];
  const { code } = run("git", args, { allowFail: true });
  if (code === 0) {
    return false;
  }
  if (code === DIFFERS) {
    return true;
  }
  throw new Error(`git diff --cached --quiet in ${dir} exited ${code}`);
}

// Saves what checkout `dir` holds uncommitted to `to.file`, under the title
// `to.title`, and stages it all, which the caller's drop undoes. False, and
// no file written, when the checkout is clean. A git or fs error throws.
function saveDroppedPatch(
  dir: string,
  to: { file: string; title: string },
): boolean {
  const base = gitIn(dir, ["rev-parse", "HEAD"]).trim();
  gitIn(dir, ["add", "-A"]);
  if (!stagedDiffers(dir)) {
    return false;
  }
  fs.mkdirSync(path.dirname(to.file), { recursive: true });
  const temp = `${to.file}.tmp`;
  try {
    gitIn(dir, [
      "diff",
      "--cached",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `--output=${temp}`,
      "HEAD",
    ]);
    const header = [
      to.title,
      `Base: ${base}`,
      `To restore: check out ${base}, then run git apply --index ${path.basename(to.file)}`,
      "",
      "",
    ].join("\n");
    fs.writeFileSync(
      to.file,
      Buffer.concat([Buffer.from(header), fs.readFileSync(temp)]),
    );
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return true;
}

export { saveDroppedPatch };
