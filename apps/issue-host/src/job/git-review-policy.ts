// Deliberately a small Git language, not a filter over Git's ever-growing CLI.
// Paths must follow --; grep patterns must follow -e. Unknown modes fail closed.
import { z } from "zod";

const MAX_ARGUMENT_LENGTH = 4096;
const MAX_ARGUMENTS = 100;
const DEFAULT_PAGE_LINES = 200;
const MAX_ROOTS = 32;
const REQUEST = z.strictObject({
  cwd: z.string().min(1).max(MAX_ARGUMENT_LENGTH),
  argv: z
    .array(z.string().min(1).max(MAX_ARGUMENT_LENGTH))
    .min(1)
    .max(MAX_ARGUMENTS),
  offset: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(DEFAULT_PAGE_LINES),
});
const ROOTS = z.array(z.string().min(1)).min(1).max(MAX_ROOTS);
const REVISION = /^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/u;
const NUMERIC_OPTION =
  /^(?:--max-count=|--skip=|--abbrev=|--short=|-n|-U|-L)\d+(?:,\d+)?$/u;
const CONTROLS = /\p{Cc}/u;
const FORMATS = new Set([
  "--format=oneline",
  "--format=short",
  "--format=medium",
  "--format=full",
  "--format=fuller",
  "--format=raw",
  "--format=reference",
  "--format=%H",
]);
const COMMON_DIFF = [
  "-p",
  "--patch",
  "--stat",
  "--numstat",
  "--shortstat",
  "--name-only",
  "--name-status",
  "--raw",
  "--summary",
  "--no-renames",
  "--find-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-prefix",
  "--binary",
  "--ignore-space-at-eol",
  "--ignore-all-space",
  "--ignore-space-change",
];
const OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ["diff", [...COMMON_DIFF, "--cached", "--staged", "--check"]],
  ["show", [...COMMON_DIFF, "--no-patch", "--oneline"]],
  [
    "log",
    [
      ...COMMON_DIFF,
      "--no-patch",
      "--oneline",
      "--all",
      "--first-parent",
      "--reverse",
      "--topo-order",
      "--date-order",
      "--no-merges",
      "--merges",
      "--decorate=short",
      "--decorate=no",
    ],
  ],
  [
    "rev-parse",
    ["--verify", "--short", "--show-toplevel", "--is-inside-work-tree"],
  ],
  ["merge-base", ["--all", "--is-ancestor", "--octopus", "--independent"]],
  [
    "ls-tree",
    ["-r", "-t", "-l", "--name-only", "--name-status", "--full-tree"],
  ],
  ["cat-file", ["-p", "-t", "-s"]],
  [
    "status",
    [
      "--short",
      "--porcelain",
      "--porcelain=v1",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=no",
      "--untracked-files=normal",
      "--untracked-files=all",
    ],
  ],
  [
    "blame",
    ["--porcelain", "--line-porcelain", "-l", "-s", "-w", "-M", "-C", "--root"],
  ],
  [
    "grep",
    ["-n", "-i", "-F", "-E", "-G", "-w", "-l", "-L", "--cached", "--full-name"],
  ],
]);
const DIFF_COMMANDS = new Set(["diff", "show", "log"]);
const NUMERIC_COMMANDS = new Set(["diff", "show", "log", "rev-parse", "blame"]);

interface Query {
  command: string;
  args: string[];
  paths: string[];
}

function safePath(value: string): void {
  if (
    value.startsWith("/") ||
    value.startsWith(":") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part === ".." || part.toLowerCase() === ".git") ||
    CONTROLS.test(value)
  ) {
    throw new Error(`Unsupported path: ${value}`);
  }
}

function safeRevision(value: string): void {
  const [revision, ...paths] = value.split(":");
  if (
    revision === undefined ||
    !REVISION.test(revision) ||
    paths.length > 1 ||
    revision.includes("@{")
  ) {
    throw new Error(`Unsupported revision: ${value}`);
  }
  safePath(revision);
  for (const file of paths) {
    safePath(file);
  }
}

function allowedOption(
  command: string,
  arg: string,
  options: readonly string[],
): boolean {
  if (options.includes(arg)) {
    return true;
  }
  if ((command === "show" || command === "log") && FORMATS.has(arg)) {
    return true;
  }
  return NUMERIC_COMMANDS.has(command) && NUMERIC_OPTION.test(arg);
}

interface ArgumentState {
  paths: string[];
  afterSeparator: boolean;
  pattern: boolean;
  patterns: number;
}

function operand(command: string, arg: string, paths: string[]): void {
  if (command === "status") {
    throw new Error("Paths must follow --");
  }
  safeRevision(arg);
  // Git can interpret a revision-looking operand as a worktree path.
  // Validate that ambiguity too, before Git gets to choose.
  const [revision] = arg.split(":");
  if (revision !== undefined) {
    paths.push(revision);
  }
  const [, file] = arg.split(":");
  if (file !== undefined) {
    paths.push(file);
  }
}

function consume(
  command: string,
  arg: string,
  options: readonly string[],
  state: ArgumentState,
): void {
  if (CONTROLS.test(arg)) {
    throw new Error("Control characters are unsupported in Git arguments");
  }
  if (state.pattern) {
    state.pattern = false;
  } else if (state.afterSeparator) {
    safePath(arg);
    state.paths.push(arg);
  } else if (arg === "--") {
    state.afterSeparator = true;
  } else if (arg === "-e" && command === "grep") {
    state.pattern = true;
    state.patterns += 1;
  } else if (arg.startsWith("-")) {
    if (!allowedOption(command, arg, options)) {
      throw new Error(`Unsupported option: ${arg}`);
    }
  } else {
    operand(command, arg, state.paths);
  }
}

function queryOf(argv: readonly string[]): Query {
  const [command, ...input] = argv;
  const options = OPTIONS.get(command ?? "");
  if (command === undefined || options === undefined) {
    throw new Error(`Unsupported subcommand: ${command ?? "(missing)"}`);
  }
  const state: ArgumentState = {
    paths: [],
    afterSeparator: false,
    pattern: false,
    patterns: 0,
  };
  for (const arg of input) {
    consume(command, arg, options, state);
  }
  if (state.pattern || (command === "grep" && state.patterns === 0)) {
    throw new Error("grep requires -e followed by a pattern");
  }
  if (command === "blame" && !state.afterSeparator) {
    throw new Error("blame requires -- followed by a repository path");
  }
  const args = [command];
  if (DIFF_COMMANDS.has(command)) {
    args.push("--no-ext-diff", "--no-textconv");
  }
  args.push(...input);
  return { command, args, paths: state.paths };
}

export type { Query };
export { queryOf, REQUEST, ROOTS };
