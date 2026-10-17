// Whether a TypeScript file's change between two commits only adds
// type-level lines, so that the spec writer may extend an interface its reply
// declares as `changed` (the wiki's Pipeline-Roles-Spec-Writer): fields or
// members of an interface, type alias or object type, union members,
// `import type` and comments. The diff may remove no line, and the file's
// JavaScript, as TypeScript emits it with types and comments erased, must be
// the same before and after: a new function, statement, value import or
// changed runtime value changes the emitted code. Uses the worktree's own
// `typescript` package; without it, a change counts as code.

import type { TranspileOptions } from "typescript";
import {
  DIRECTIVE_COMMENT,
  showFile,
  worktreeTypeScript,
} from "./comment-only.ts";
import { run } from "./process.ts";

type TypeScript = typeof import("typescript");

// A TypeScript file's path, and one that keeps JSX.
const TS_FILE = /\.[cm]?tsx?$/u;
const TSX_FILE = /\.tsx$/u;
// A hunk's header in a unified diff; the file's headers come before the first.
const HUNK_HEADER = "@@";

// Why a change is not type-only additions.
type TypeOnlyFault =
  | "it is not a TypeScript file"
  | "the diff removes or changes lines; it may only add them"
  | "it adds a directive comment, which changes what a tool checks"
  | "it does not exist at both the base and the spec head"
  | "the worktree has no typescript package to read its types with"
  | "it does not parse as TypeScript"
  | "it adds runtime code, not only types: its emitted JavaScript changed";

// The lines of a diff with no context lines from its first hunk's header on:
// each a hunk header, a removed line or an added line.
function hunkLines(diff: readonly string[]): readonly string[] {
  const first = diff.findIndex((line) => line.startsWith(HUNK_HEADER));
  if (first === -1) {
    return [];
  }
  return diff.slice(first);
}

// The file name transpileModule parses `file` as, or undefined for a file
// that isn't TypeScript.
function parsedName(file: string): "file.ts" | "file.tsx" | undefined {
  if (TSX_FILE.test(file)) {
    return "file.tsx";
  }
  if (TS_FILE.test(file)) {
    return "file.ts";
  }
  return undefined;
}

// The JavaScript TypeScript emits for `text`, with types and comments erased
// and every value import kept, or undefined if it doesn't parse.
function emitted(
  ts: TypeScript,
  fileName: string,
  text: string,
): string | undefined {
  const options: TranspileOptions = {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName,
    reportDiagnostics: true,
  };
  const output = ts.transpileModule(text, options);
  if ((output.diagnostics ?? []).length > 0) {
    return undefined;
  }
  return output.outputText;
}

// Why `file`'s change from `fromRev` to `toRev` in the checkout at `wt` is not
// type-only additions, or null when it is.
function typeOnlyAdditionsFault(
  wt: string,
  file: string,
  fromRev: string,
  toRev: string,
): TypeOnlyFault | null {
  const fileName = parsedName(file);
  if (fileName === undefined) {
    return "it is not a TypeScript file";
  }
  const diff = run("git", [
    "-C",
    wt,
    "diff",
    "--no-ext-diff",
    "-U0",
    fromRev,
    toRev,
    "--",
    file,
  ]).stdout.split("\n");
  const hunks = hunkLines(diff);
  if (hunks.some((line) => line.startsWith("-"))) {
    return "the diff removes or changes lines; it may only add them";
  }
  const added = hunks.filter((line) => line.startsWith("+"));
  if (added.some((line) => DIRECTIVE_COMMENT.test(line))) {
    return "it adds a directive comment, which changes what a tool checks";
  }
  const before = showFile(wt, fromRev, file);
  const after = showFile(wt, toRev, file);
  if (before === undefined || after === undefined) {
    return "it does not exist at both the base and the spec head";
  }
  const ts = worktreeTypeScript(wt);
  if (ts === undefined) {
    return "the worktree has no typescript package to read its types with";
  }
  const was = emitted(ts, fileName, before);
  const now = emitted(ts, fileName, after);
  if (was === undefined || now === undefined) {
    return "it does not parse as TypeScript";
  }
  if (was !== now) {
    return "it adds runtime code, not only types: its emitted JavaScript changed";
  }
  return null;
}

export { typeOnlyAdditionsFault };
