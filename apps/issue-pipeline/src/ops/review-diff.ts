// What prepare-review (sync.ts) writes around a branch's code diff: the
// messages of its commits above it, the issue's wiki commits below it, and the
// review bundle, which adds the changed files' head texts after all of that.

import { z } from "zod";
import type { Config } from "../config.ts";
import { wikiCfg } from "../config.ts";
import { run } from "../process.ts";
import { wikiDiff } from "../wiki.ts";

// Changed files' whole texts go into the review bundle, in path order, while
// it stays within this; about 57k tokens at 3.5 characters a token, so a
// review that starts with the bundle keeps most of its context.
const REVIEW_BUNDLE_MAX_CHARS = 200_000;

// The heading over the bundle's changed files.
const FILES_HEADING = "# Changed files at the head, in path order";
// A numstat record git gives a binary file: no line counts.
const BINARY_NUMSTAT = /^-\t-\t/u;
// A run of backticks, which a fence around a file's text must outrun.
const BACKTICK_RUN = /`+/gu;
// CommonMark's shortest code fence.
const MIN_FENCE = 3;

// Why a changed file is listed by path only.
const PATH_ONLY: Readonly<Record<"deleted" | "binary" | "past", string>> = {
  deleted: "Deleted at the head: path only.",
  binary: "Binary: path only.",
  past: "Past the bundle's size bound: path only. Read it in the checkout if you need it.",
};

// A changed file of the reviewed range, by what the bundle can hold of it.
type RangeFile =
  | { path: string; kind: "text" | "deleted" | "binary" }
  | { path: string; kind: "gitlink"; old: string; new: string };

// --raw --no-abbrev --no-renames -z emits a header and path per change.
// Full object ids identify gitlink commits even when they aren't local objects.
const RAW_MODE = /^[0-7]{6}$/u;
const RAW_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RAW_STATUS = /^[A-Z]$/u;
const RAW_HEADER = z.tuple([
  z.string().regex(RAW_MODE),
  z.string().regex(RAW_MODE),
  z.string().regex(RAW_OID),
  z.string().regex(RAW_OID),
  z.string().regex(RAW_STATUS),
]);
const RAW_RECORD = z.tuple([z.string().startsWith(":"), z.string()]);

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

// The NUL-separated records `git diff <extra> range` prints, without the
// empty one after the last NUL.
function diffRecords(wt: string, range: string, extra: string[]): string[] {
  const args = ["-C", wt, "diff", "--no-renames", "-z", ...extra, range];
  return run("git", args)
    .stdout.split("\0")
    .filter((record) => record !== "");
}

// The files `range` changes, in byte order of their paths, so the order
// doesn't depend on the locale. A renamed file is its old path, deleted, and
// its new one.
function rangeFiles(wt: string, range: string): RangeFile[] {
  const binary = new Set(
    diffRecords(wt, range, ["--numstat"])
      .filter((record) => BINARY_NUMSTAT.test(record))
      .map((record) => record.replace(BINARY_NUMSTAT, "")),
  );
  const records = diffRecords(wt, range, ["--raw", "--no-abbrev"]);
  const files: RangeFile[] = [];
  for (let i = 0; i < records.length; i += 2) {
    const [header, file] = RAW_RECORD.parse(records.slice(i, i + 2));
    const [oldMode, newMode, oldOid, newOid, status] = RAW_HEADER.parse(
      header.slice(1).split(" "),
    );
    // Check both sides before deletion/binary handling or any blob read.
    if (oldMode === "160000" || newMode === "160000") {
      files.push({
        path: file,
        kind: "gitlink",
        old: objectIdentity(oldMode, oldOid),
        new: objectIdentity(newMode, newOid),
      });
    } else {
      let kind: "text" | "deleted" | "binary" = "text";
      if (binary.has(file)) {
        kind = "binary";
      }
      if (status === "D") {
        kind = "deleted";
      }
      files.push({ path: file, kind });
    }
  }
  return files.sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
}

// A missing side has no object identity; a type change may have a blob on
// one side instead of a commit. Neither case should look like a commit id.
function objectIdentity(mode: string, oid: string): string {
  if (mode === "000000") {
    return "absent";
  }
  if (mode === "160000") {
    return `commit \`${oid}\``;
  }
  return `blob \`${oid}\``;
}

// `file`'s text at `head` under its path, in a fenced block that no backtick
// run in the text can close.
function textEntry(wt: string, head: string, file: string): string {
  const text = run("git", ["-C", wt, "show", `${head}:${file}`]).stdout;
  const longest = Math.max(
    MIN_FENCE - 1,
    ...(text.match(BACKTICK_RUN) ?? []).map((backticks) => backticks.length),
  );
  const fence = "`".repeat(longest + 1);
  let body = text;
  if (!body.endsWith("\n")) {
    body += "\n";
  }
  return `\n## ${file}\n\n${fence}\n${body}${fence}\n`;
}

// `file` under its path, listed by path only, with `why`.
function pathOnly(file: string, why: keyof typeof PATH_ONLY): string {
  return `\n## ${file}\n\n${PATH_ONLY[why]}\n`;
}

// The review bundle for the reviewed range `from..head`: `diff`, the text
// prepare-review wrote to diff.patch, then each file the range changed in the
// code checkout, in path order, with its text at the head while the bundle
// stays within REVIEW_BUNDLE_MAX_CHARS. The first file that would pass it, and
// every file after it, is listed by path only, as are deleted and binary
// files. Gitlinks always list only their path and old/new object identities,
// never blob or submodule contents. The same commits and diff give the same bundle.
function reviewBundle(
  wt: string,
  range: { from: string; head: string },
  diff: string,
): string {
  let bundle = `${diff}\n\n${FILES_HEADING}\n`;
  let past = false;
  for (const file of rangeFiles(wt, `${range.from}..${range.head}`)) {
    let entry = pathOnly(file.path, "past");
    if (file.kind === "gitlink") {
      entry = `\n## ${file.path}\n\nGitlink: path only. Old: ${file.old}; new: ${file.new}.\n`;
    } else if (file.kind !== "text") {
      entry = pathOnly(file.path, file.kind);
    } else if (!past) {
      const text = textEntry(wt, range.head, file.path);
      past = bundle.length + text.length > REVIEW_BUNDLE_MAX_CHARS;
      if (!past) {
        entry = text;
      }
    }
    bundle += entry;
  }
  return bundle;
}

export { commitLog, REVIEW_BUNDLE_MAX_CHARS, reviewBundle, withWiki };
