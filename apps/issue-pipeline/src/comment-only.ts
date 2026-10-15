// Whether a file's change between two commits touches only its comments, so
// that the fails-before-fix check can skip it.

import { createRequire } from "node:module";
import path from "node:path";
import type { ScriptKind } from "typescript";
import { run } from "./process.ts";

type TypeScript = typeof import("typescript");
type ScriptKindName = keyof typeof ScriptKind;
type DataKind = "json" | "sql";

// Comments that change what tools do, so editing one is a code change.
const DIRECTIVE_COMMENT =
  /@ts-|eslint|biome-ignore|prettier-ignore|@jsx|#__PURE__|@__PURE__|webpack|@vite-ignore|istanbul|c8 ignore|<reference/u;
const CHANGED_LINE = /^[+-][^+-]/u;
// SQL counts only whole-line `--` comments, and keeps drizzle's `-->` directives.
const SQL_COMMENT_LINE = /^\s*--(?!>)/u;

const SCRIPT_KINDS: ReadonlyMap<string, ScriptKindName> = new Map<
  string,
  ScriptKindName
>([
  [".ts", "TS"],
  [".mts", "TS"],
  [".cts", "TS"],
  [".tsx", "TSX"],
  [".js", "JS"],
  [".mjs", "JS"],
  [".cjs", "JS"],
  [".jsx", "JSX"],
]);
// JSON with comments (tsconfig, biome.jsonc) and SQL migrations carry comments too.
const DATA_KINDS: ReadonlyMap<string, DataKind> = new Map<string, DataKind>([
  [".json", "json"],
  [".jsonc", "json"],
  [".json5", "json"],
  [".sql", "sql"],
]);

// The worktree's own `typescript` package, if it has one.
function worktreeTypeScript(wt: string): TypeScript | undefined {
  try {
    const typescript: TypeScript = createRequire(path.join(wt, "package.json"))(
      "typescript",
    );
    return typescript;
  } catch {
    return undefined;
  }
}

function showFile(wt: string, rev: string, file: string): string | undefined {
  const shown = run("git", ["-C", wt, "show", `${rev}:${file}`], {
    allowFail: true,
  });
  if (shown.code !== 0) {
    return undefined;
  }
  return shown.stdout;
}

function stripSql(text: string): string {
  return text
    .split("\n")
    .filter((line) => !SQL_COMMENT_LINE.test(line))
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");
}

function jsonValue(
  ts: TypeScript,
  file: string,
  text: string,
): string | undefined {
  const parsed = ts.parseConfigFileTextToJson(file, text);
  if (parsed.error !== undefined) {
    return undefined;
  }
  return JSON.stringify(parsed.config);
}

// The file printed with its comments removed, or undefined if it doesn't parse.
function printedCode(
  ts: TypeScript,
  file: string,
  text: string,
  kind: ScriptKindName,
): string | undefined {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind[kind],
  );
  // The parser's syntax errors are on the source file but not in its types.
  if (
    "parseDiagnostics" in source &&
    Array.isArray(source.parseDiagnostics) &&
    source.parseDiagnostics.length > 0
  ) {
    return undefined;
  }
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

interface Versions {
  file: string;
  before: string;
  after: string;
}

function sameWithoutComments(ts: TypeScript, versions: Versions): boolean {
  const { file, before, after } = versions;
  const extension = path.extname(file);
  const dataKind = DATA_KINDS.get(extension);
  if (dataKind === "sql") {
    return stripSql(before) === stripSql(after);
  }
  if (dataKind === "json") {
    const was = jsonValue(ts, file, before);
    return was !== undefined && was === jsonValue(ts, file, after);
  }
  const kind = SCRIPT_KINDS.get(extension);
  if (kind === undefined) {
    return false;
  }
  const was = printedCode(ts, file, before, kind);
  return was !== undefined && was === printedCode(ts, file, after, kind);
}

function editsDirective(
  wt: string,
  file: string,
  fromRev: string,
  toRev: string,
): boolean {
  const diff = run("git", [
    "-C",
    wt,
    "diff",
    "-U0",
    fromRev,
    toRev,
    "--",
    file,
  ]).stdout;
  return diff
    .split("\n")
    .some((line) => CHANGED_LINE.test(line) && DIRECTIVE_COMMENT.test(line));
}

// True when a JS, TS, JSON or SQL file differs between two commits only in
// comments and layout. Uses the worktree's own `typescript` package; without
// it, or for any other file type, a change counts as code.
function commentOnlyChange(
  wt: string,
  file: string,
  fromRev: string,
  toRev: string,
): boolean {
  const extension = path.extname(file);
  if (!(SCRIPT_KINDS.has(extension) || DATA_KINDS.has(extension))) {
    return false;
  }
  const ts = worktreeTypeScript(wt);
  if (ts === undefined) {
    return false;
  }
  const before = showFile(wt, fromRev, file);
  const after = showFile(wt, toRev, file);
  if (before === undefined || after === undefined) {
    return false;
  }
  if (editsDirective(wt, file, fromRev, toRev)) {
    return false;
  }
  return sameWithoutComments(ts, { after, before, file });
}

export { commentOnlyChange };
