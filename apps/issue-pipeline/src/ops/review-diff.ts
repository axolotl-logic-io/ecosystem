// What prepare-review (sync.ts) writes around a branch's code diff: the
// messages of its commits above it, and the issue's wiki commits below it.

import type { Config } from "../config.ts";
import { wikiCfg } from "../config.ts";
import { run } from "../process.ts";
import { wikiDiff } from "../wiki.ts";

// The messages of the commits in `range`, oldest first, under a heading, for
// the diff's top: the scope lens counts a commit's message as explaining it
// (unrelated-fixes-allowed). Empty when `range` has no commits.
function commitLog(wt: string, range: string): string {
  const format = "--format=commit %h%n%n%B";
  const args = ["-C", wt, "log", "--reverse", format, range];
  const log = run("git", args).stdout.trimEnd();
  if (log === "") {
    return "";
  }
  return `# Commits, oldest first\n\n${log}\n\n# Diff\n\n`;
}

// Wiki commits come after the code diff. They are always the whole wiki change so
// far, even in a re-review that shows only the code since the last review.
function withWiki(
  cfg: Config,
  n: number,
  diff: string,
): { text: string; files: string[] } {
  const wiki = wikiDiff(cfg, n);
  const settings = wikiCfg(cfg);
  if (wiki.diff === "" || settings === null) {
    return { text: diff, files: wiki.files };
  }
  const heading = `# Wiki changes (paths under ${settings.dir}/; pushed to the wiki when the PR merges)`;
  return { text: `${diff}\n\n${heading}\n\n${wiki.diff}`, files: wiki.files };
}

export { commitLog, withWiki };
