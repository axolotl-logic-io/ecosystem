// git commit's option grammar, as `pipeline_commit` reads a call's
// arguments before git runs: which options it refuses, which take a value,
// where each message file's path sits, and the pathspecs. A
// refused option throws a Refusal, which the planner (pipeline-commit.ts)
// turns into its refused plan.

// Long options that are refused, for keeping the pipeline's identity, the
// pushed history and the hooks, or for reading input the planner can't see.
const REFUSED_LONG: readonly string[] = [
  "amend",
  "no-verify",
  "author",
  "date",
  "reset-author",
  "pathspec-from-file",
];
// Short options that are refused: -n is --no-verify.
const REFUSED_SHORT = "n";
// Long options that take their value as the next argument when it isn't
// attached with `=`.
const LONG_WITH_VALUE: readonly string[] = [
  "message",
  "file",
  "reuse-message",
  "reedit-message",
  "fixup",
  "squash",
  "template",
  "trailer",
  "cleanup",
];
// Short options that take a value: the rest of the cluster, or the next
// argument.
const SHORT_WITH_VALUE = "mFCct";
// Short options whose optional value can only be attached.
const SHORT_OPTIONAL_VALUE = "uS";
const LONG_OPTION = /^--(?<name>[^=]+)(?:=(?<value>[\s\S]*))?$/u;

// How many arguments an option used: itself, or itself and its value.
type Used = 1 | 2;

// A commit call's arguments, read: the options as given, where in them each
// message file's path sits, the pathspecs and whether it is a dry run.
interface ReadArgs {
  options: string[];
  files: number[];
  paths: string[];
  dryRun: boolean;
}

class Refusal extends Error {}

function refuse(error: string): never {
  throw new Refusal(error);
}

// The option's value: attached, or else the next argument.
function valueAt(args: readonly string[], at: number, option: string): string {
  const value = args[at + 1];
  if (value === undefined) {
    return refuse(`${option} needs a value`);
  }
  return value;
}

// The refused or known option `name` abbreviates, as git accepts any unique
// prefix of a long option; `name` itself when it abbreviates none.
function longNameOf(name: string): string {
  const refused = REFUSED_LONG.find((full) => full.startsWith(name));
  if (refused !== undefined) {
    return refuse(`--${name} is not allowed (--${refused})`);
  }
  const known = LONG_WITH_VALUE.filter((full) => full.startsWith(name));
  if (known.length === 1 && known[0] !== undefined) {
    return known[0];
  }
  return name;
}

// Reads the long option at `args[at]` into `read`, and returns how many
// arguments it used.
function readLong(args: readonly string[], at: number, read: ReadArgs): Used {
  const { name = "", value } = LONG_OPTION.exec(args[at] ?? "")?.groups ?? {};
  const full = longNameOf(name);
  if (full === "dry-run") {
    read.dryRun = true;
  }
  if (!LONG_WITH_VALUE.includes(full)) {
    read.options.push(args[at] ?? "");
    return 1;
  }
  const given = value ?? valueAt(args, at, `--${full}`);
  if (full === "file") {
    read.options.push("--file", given);
  } else {
    read.options.push(`--${full}=${given}`);
  }
  messageOption(full, given, read);
  if (value === undefined) {
    return 2;
  }
  return 1;
}

// Keeps where a message file's path, the last of the options read so far,
// sits, refusing a message read from stdin.
function messageOption(option: string, value: string, read: ReadArgs): void {
  if (option !== "file" && option !== "F") {
    return;
  }
  if (value === "-") {
    refuse("-F - is not allowed: the message can't come from stdin");
  }
  read.files.push(read.options.length - 1);
}

// Reads the short option cluster at `args[at]` into `read`, and returns how
// many arguments it used.
function readShort(args: readonly string[], at: number, read: ReadArgs): Used {
  const cluster = args[at] ?? "";
  for (let index = 1; index < cluster.length; index += 1) {
    const flag = cluster.charAt(index);
    const rest = cluster.slice(index + 1);
    if (REFUSED_SHORT.includes(flag)) {
      refuse(`-${flag} is not allowed (--no-verify)`);
    }
    if (SHORT_OPTIONAL_VALUE.includes(flag)) {
      break;
    }
    if (SHORT_WITH_VALUE.includes(flag)) {
      const value = rest || valueAt(args, at, `-${flag}`);
      read.options.push(cluster.slice(0, index + 1), value);
      messageOption(flag, value, read);
      if (rest === "") {
        return 2;
      }
      return 1;
    }
  }
  read.options.push(cluster);
  return 1;
}

function readArgs(args: readonly string[]): ReadArgs {
  const read: ReadArgs = {
    options: [],
    files: [],
    paths: [],
    dryRun: false,
  };
  let at = 0;
  let pathsOnly = false;
  while (at < args.length) {
    const arg = args[at] ?? "";
    if (pathsOnly || arg === "-" || !arg.startsWith("-")) {
      read.paths.push(arg);
      at += 1;
    } else if (arg === "--") {
      pathsOnly = true;
      at += 1;
    } else if (arg.startsWith("--")) {
      at += readLong(args, at, read);
    } else {
      at += readShort(args, at, read);
    }
  }
  return read;
}

export type { ReadArgs };
export { Refusal, readArgs, refuse };
