// What a `pipeline_commit` call commits, worked out before git runs: the
// planner reads the call's options (commit-options.ts), refuses the flags and
// paths a session may not use, routes the pathspecs, which are relative to
// the job's folder, to its code checkout (repo/) and its wiki checkout
// (docs/), refuses those into a checkout the stage may not write
// (commit-needs-write-access, #338), adds the trailer that names the session
// to every commit, `Pipeline-Session: <launch key>@<job start>`, when its
// scope names the job's start, and owns the session variable that tells the
// tool its scope. It runs nothing; the tool (pipeline-commit-tool.ts) runs
// the argv it returns.

import { matchAny } from "../globs.ts";
import type { ReadArgs } from "./commit-options.ts";
import { Refusal, readArgs, refuse } from "./commit-options.ts";
import type { CheckoutScope, CommitScope, PathScope } from "./commit-scope.ts";

type CheckoutName = "repo" | "docs";

// What an error calls each checkout.
const CHECKOUT_LABELS: Readonly<Record<CheckoutName, string>> = {
  repo: "the code checkout",
  docs: "the wiki checkout",
};

// A pathspec routed to a checkout, relative to it.
interface Routed {
  checkout: CheckoutName;
  path: string;
}

// A call's plan: refused with the reason, or the git argv to run in the code
// checkout (null for none) and in the wiki checkout (in order, null for none).
type CommitPlan =
  | { kind: "refused"; error: string }
  | {
      kind: "commit";
      code: string[] | null;
      wiki: string[][] | null;
      dryRun: boolean;
    };

// The pathspec normalized, or refused when it reaches outside the job's
// folder or uses pathspec magic.
function checkedPath(spec: string): string {
  const segments = spec.split("/").filter((s) => s !== "" && s !== ".");
  if (
    spec.startsWith("/") ||
    segments[0]?.startsWith(":") ||
    segments.includes("..") ||
    spec.includes("\0")
  ) {
    return refuse(`${spec}: only paths inside the checkout may be committed`);
  }
  return segments.join("/") || ".";
}

// The job's checkouts, by name.
function checkoutsOf(scope: PathScope): [CheckoutName, CheckoutScope][] {
  const list: [CheckoutName, CheckoutScope][] = [["repo", scope.repo]];
  if (scope.docs !== null) {
    list.push(["docs", scope.docs]);
  }
  return list;
}

// Where pathspec `spec` goes: refused unless it is in a checkout of the job
// that the stage may write.
function routeOf(spec: string, scope: PathScope): Routed {
  const [first = "", ...rest] = checkedPath(spec).split("/");
  const checkouts = checkoutsOf(scope);
  const found = checkouts.find(([, checkout]) => checkout.dir === first);
  if (found === undefined) {
    const dirs = checkouts.map(([, checkout]) => `${checkout.dir}/`);
    return refuse(
      `${spec}: not in a checkout of this job; paths start with ${dirs.join(" or ")}`,
    );
  }
  const [name, { dir, access }] = found;
  const relative = checkedPath(rest.join("/"));
  if (relative.split("/").includes(".git")) {
    refuse(`${spec}: checkout metadata may not be committed`);
  }
  if (access !== "write") {
    refuse(
      `${spec}: this stage has ${access} access to ${CHECKOUT_LABELS[name]} (${dir}/); it may not commit there`,
    );
  }
  return { checkout: name, path: relative };
}

// A message file's path as checkout folder `dir`, inside the job's folder,
// sees it: the call names it relative to the job's folder.
function fileFrom(file: string, dir: string): string {
  if (file.startsWith("/")) {
    return file;
  }
  return `${"../".repeat(dir.split("/").length)}${file}`;
}

// The call's options, its message files read from checkout folder `dir`.
function optionsIn(read: ReadArgs, dir: string): string[] {
  return read.options.map((option, at) => {
    if (read.files.includes(at)) {
      return fileFrom(option, dir);
    }
    return option;
  });
}

function withPaths(argv: string[], paths: readonly string[]): string[] {
  if (paths.length === 0) {
    return argv;
  }
  return [...argv, "--", ...paths];
}

// The argv that ends a commit with `trailer`, or none for no trailer.
function trailerArgs(trailer: string | null): string[] {
  if (trailer === null) {
    return [];
  }
  return ["--trailer", trailer];
}

// The wiki's argv: everything when it got no pathspec, else the named paths,
// committed with `trailer` (none when null).
function wikiArgv(
  read: ReadArgs,
  paths: string[],
  where: { dir: string; trailer: string | null },
): string[][] {
  const { dir, trailer } = where;
  const message = read.message.flatMap(([option = "", value]): string[] => {
    if (value === undefined) {
      return [option];
    }
    if (option === "-F") {
      return [option, fileFrom(value, dir)];
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
    withPaths(["commit", ...message, ...trailerArgs(trailer)], paths),
  ];
}

// The plan for one call of `pipeline_commit` with git commit's `args`, in a
// session that may commit what `scope` allows, each commit ending with the
// trailer `trailer` (none when null). A call that names pathspecs commits
// only the checkouts they are in; one that names none commits each checkout
// the stage may write.
function planOf(
  args: readonly string[],
  scope: PathScope,
  trailer: string | null,
): CommitPlan {
  const read = readArgs(args);
  const codePaths: string[] = [];
  const wikiPaths: string[] = [];
  for (const spec of read.paths) {
    const routed = routeOf(spec, scope);
    if (routed.checkout === "docs") {
      wikiPaths.push(routed.path);
    } else if (
      scope.allowed.length > 0 &&
      (matchAny(scope.allowed, routed.path) ||
        routed.path === "." ||
        routed.path.includes("*") ||
        routed.path.includes("?") ||
        scope.allowed.some((glob) => glob.startsWith(`${routed.path}/`)))
    ) {
      codePaths.push(routed.path);
    } else {
      refuse(`${spec}: outside the paths this session may commit`);
    }
  }
  const named = read.paths.length > 0;
  const { repo, docs } = scope;
  let code: string[] | null = null;
  if (
    repo.access === "write" &&
    scope.allowed.length > 0 &&
    (!named || codePaths.length > 0)
  ) {
    const options = optionsIn(read, repo.dir);
    const commit = ["commit", ...options, ...trailerArgs(trailer)];
    code = withPaths(commit, codePaths);
  }
  let wiki: string[][] | null = null;
  if (docs?.access === "write" && (!named || wikiPaths.length > 0)) {
    wiki = wikiArgv(read, wikiPaths, { dir: docs.dir, trailer });
  }
  return { kind: "commit", code, wiki, dryRun: read.dryRun };
}

// The trailer that names session `key` of the job that started at
// `jobStartedAt` on each of its commits, or null when the scope doesn't
// name the job's start.
function sessionTrailer(
  scope: Pick<CommitScope, "key" | "jobStartedAt">,
): string | null {
  if (scope.jobStartedAt === undefined) {
    return null;
  }
  return `Pipeline-Session: ${scope.key}@${scope.jobStartedAt}`;
}

// The plan for `args` within `scope`, each commit ending with `trailer`
// (none when null): refused, naming the flag or path, before anything runs;
// or the argv for each repo.
function commitArgsOf(
  args: readonly string[],
  scope: PathScope,
  trailer: string | null,
): CommitPlan {
  try {
    return planOf(args, scope, trailer);
  } catch (error: unknown) {
    if (error instanceof Refusal) {
      return { kind: "refused", error: error.message };
    }
    throw error;
  }
}

export type { CommitPlan };
export { commitArgsOf, sessionTrailer };
