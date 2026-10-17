// What a `pipeline_commit` call commits, worked out before git runs: the
// planner reads the call's options (commit-options.ts), refuses the flags and
// paths a session may not use, splits the pathspecs between the code repo and
// the wiki checkout, and owns the session variable that tells the tool its
// scope. It runs nothing; the tool (pipeline-commit-tool.ts) runs the argv it
// returns.

import { z } from "zod";
import { matchAny } from "../globs.ts";
import type { ReadArgs } from "./commit-options.ts";
import { Refusal, readArgs, refuse } from "./commit-options.ts";

// The tool's name, as pi's --tools names it.
const COMMIT_TOOL = "pipeline_commit";
// The session variable that carries the tool's scope, as JSON.
const COMMIT_SCOPE_ENV = "ISSUE_PIPELINE_COMMIT_SCOPE";
const WIKI_ACCESS = z.enum(["none", "read", "write"]);
// A session's commit scope: the job's control socket, the launch it is, its
// checkout, the wiki's folder in the checkout (null with no wiki), its wiki
// access, and the code globs it may commit.
const COMMIT_SCOPE = z.object({
  socket: z.string(),
  key: z.string(),
  checkout: z.string(),
  wikiDir: z.string().nullable(),
  wikiAccess: WIKI_ACCESS,
  allowed: z.array(z.string()).readonly(),
});

type WikiAccess = z.infer<typeof WIKI_ACCESS>;
type CommitScope = z.infer<typeof COMMIT_SCOPE>;

// What a session may commit: the wiki's folder (null with no wiki), its wiki
// access and the code globs it may commit (none: wiki only).
interface PathScope {
  wikiDir: string | null;
  wikiAccess: WikiAccess;
  allowed: readonly string[];
}

// A call's plan: refused with the reason, or the git argv to run in the code
// repo (null for none) and in the wiki checkout (in order, null for none).
type CommitPlan =
  | { kind: "refused"; error: string }
  | {
      kind: "commit";
      code: string[] | null;
      wiki: string[][] | null;
      dryRun: boolean;
    };

// The pathspec normalized, or refused when it reaches outside the checkout
// or uses pathspec magic.
function checkedPath(spec: string): string {
  const segments = spec.split("/").filter((s) => s !== "" && s !== ".");
  if (spec.startsWith("/") || spec.startsWith(":") || segments.includes("..")) {
    return refuse(`${spec}: only paths inside the checkout may be committed`);
  }
  return segments.join("/") || ".";
}

// The pathspec relative to the wiki folder, or null when it is a code path.
function wikiPathOf(spec: string, wikiDir: string | null): string | null {
  if (wikiDir === null) {
    return null;
  }
  if (spec === wikiDir) {
    return ".";
  }
  if (spec.startsWith(`${wikiDir}/`)) {
    return spec.slice(wikiDir.length + 1);
  }
  return null;
}

// A message file's path as the wiki checkout sees it.
function fromWiki(file: string, wikiDir: string): string {
  if (file.startsWith("/")) {
    return file;
  }
  const inside = wikiPathOf(checkedPath(file), wikiDir);
  if (inside !== null) {
    return inside;
  }
  return `${"../".repeat(wikiDir.split("/").length)}${file}`;
}

function withPaths(argv: string[], paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return argv;
  }
  return [...argv, "--", ...paths];
}

// The wiki's argv: everything when it got no pathspec, else the named paths.
function wikiArgv(
  read: ReadArgs,
  paths: string[],
  wikiDir: string,
): string[][] {
  const message = read.message.flatMap(([option = "", value]): string[] => {
    if (value === undefined) {
      return [option];
    }
    if (option === "-F") {
      return [option, fromWiki(value, wikiDir)];
    }
    return [option, value];
  });
  if (read.dryRun) {
    const all: string[] = [];
    if (paths.length === 0) {
      all.push("-a");
    }
    return [withPaths(["commit", "--dry-run", ...all, ...message], paths)];
  }
  return [
    withPaths(["add", "-A"], paths),
    withPaths(["commit", ...message], paths),
  ];
}

// The plan for one call of `pipeline_commit` with git commit's `args`, in a
// session that may commit what `scope` allows.
function planOf(args: readonly string[], scope: PathScope): CommitPlan {
  const read = readArgs(args);
  const codePaths: string[] = [];
  const wikiPaths: string[] = [];
  for (const spec of read.paths.map(checkedPath)) {
    const inWiki = wikiPathOf(spec, scope.wikiDir);
    if (inWiki !== null && scope.wikiAccess !== "write") {
      refuse(`${spec}: this session may not commit to the wiki`);
    }
    if (inWiki !== null) {
      wikiPaths.push(inWiki);
    } else if (matchAny(scope.allowed, spec)) {
      codePaths.push(spec);
    } else {
      refuse(`${spec}: outside the paths this session may commit`);
    }
  }
  let code: string[] | null = null;
  const onlyWiki = wikiPaths.length > 0 && codePaths.length === 0;
  if (scope.allowed.length > 0 && !onlyWiki) {
    code = withPaths(["commit", ...read.options], codePaths);
  }
  let wiki: string[][] | null = null;
  if (scope.wikiAccess === "write" && scope.wikiDir !== null) {
    wiki = wikiArgv(read, wikiPaths, scope.wikiDir);
  }
  return { kind: "commit", code, wiki, dryRun: read.dryRun };
}

// The plan for `args` within `scope`: refused, naming the flag or path, before
// anything runs; or the argv for each repo.
function commitArgsOf(args: readonly string[], scope: PathScope): CommitPlan {
  try {
    return planOf(args, scope);
  } catch (error: unknown) {
    if (error instanceof Refusal) {
      return { kind: "refused", error: error.message };
    }
    throw error;
  }
}

// The session variables that give the tool `scope`.
function commitEnvOf(scope: CommitScope): Record<string, string> {
  return Object.fromEntries([[COMMIT_SCOPE_ENV, JSON.stringify(scope)]]);
}

// The scope in a session's variables, or null when it has none or it is
// malformed.
function commitScopeIn(
  env: Readonly<Record<string, string | undefined>>,
): CommitScope | null {
  const text = new Map(Object.entries(env)).get(COMMIT_SCOPE_ENV);
  if (text === undefined) {
    return null;
  }
  try {
    const parsed = COMMIT_SCOPE.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

export type { CommitPlan, CommitScope, PathScope, WikiAccess };
export {
  COMMIT_SCOPE_ENV,
  COMMIT_TOOL,
  commitArgsOf,
  commitEnvOf,
  commitScopeIn,
};
