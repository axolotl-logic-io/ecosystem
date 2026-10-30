// What a `pipeline_commit` call commits, worked out before git runs: the
// planner reads the call's options (commit-options.ts), refuses the flags and
// paths a session may not use, routes the pathspecs, which are relative to
// the job's folder, to its code checkout (repo/), refuses those outside it
// or into a checkout the stage may not write
// (commit-needs-write-access, #338), adds the trailer that names the session
// to every commit, `Pipeline-Session: <launch key>@<job start>`, when its
// scope names the job's start, and owns the session variable that tells the
// tool its scope. It runs nothing; the tool (pipeline-commit-tool.ts) runs
// the argv it returns.

import { z } from "zod";
import { matchAny } from "../globs.ts";
import { INVOCATION_BINDING } from "../job/session-identity.ts";
import type { ReadArgs } from "./commit-options.ts";
import { Refusal, readArgs, refuse } from "./commit-options.ts";

// The tool's name, as pi's --tools names it.
const COMMIT_TOOL = "pipeline_commit";
// The session variable that carries the tool's scope, as JSON.
const COMMIT_SCOPE_ENV = "ISSUE_PIPELINE_COMMIT_SCOPE";
const ACCESS = z.enum(["read", "write"]);
// One of the job's checkouts: its folder in the job's folder, and the
// stage's access to it.
const CHECKOUT_SCOPE = z.object({ dir: z.string(), access: ACCESS });
// A session's commit scope: the job's control socket, the launch it is, the
// job's start, the job's folder, its code checkout, and the code globs,
// relative to the code checkout, it may commit. A job started before the trailer (#402) sends no `jobStartedAt`,
// and its sessions commit without the trailer.
const PATH_SCOPE = z.object({
  repo: CHECKOUT_SCOPE,
  allowed: z.array(z.string()).readonly(),
});
const COMMIT_SCOPE = PATH_SCOPE.extend({
  socket: z.string(),
  key: z.string(),
  // The job's invocation binding, which its push requests name (#168).
  execution: INVOCATION_BINDING,
  jobStartedAt: z.string().optional(),
  root: z.string(),
});
type CheckoutScope = z.infer<typeof CHECKOUT_SCOPE>;
type CommitScope = z.infer<typeof COMMIT_SCOPE>;

// What a session may commit: its code checkout and the code globs it may
// commit there (none: nothing).
interface PathScope {
  repo: CheckoutScope;
  allowed: readonly string[];
}

// A call's plan: refused with the reason, or the git argv to run in the code
// checkout (null for none) and the call's pathspecs, each checked against the
// session's allowed paths, relative to the code checkout.
type CommitPlan =
  | { kind: "refused"; error: string }
  | {
      kind: "commit";
      code: string[] | null;
      paths: string[];
      dryRun: boolean;
    };

// The pathspec normalized, or refused when it reaches outside the job's
// folder or uses pathspec magic.
function checkedPath(spec: string): string {
  const segments = spec.split("/").filter((s) => s !== "" && s !== ".");
  if (spec.startsWith("/") || spec.startsWith(":") || segments.includes("..")) {
    return refuse(`${spec}: only paths inside the checkout may be committed`);
  }
  return segments.join("/") || ".";
}

// Pathspec `spec` relative to the code checkout: refused unless it is in
// that checkout and the stage may write it.
function codePathOf(spec: string, scope: PathScope): string {
  const [first = "", ...rest] = checkedPath(spec).split("/");
  const { dir, access } = scope.repo;
  if (first !== dir) {
    return refuse(
      `${spec}: not in a checkout of this job; paths start with ${dir}/`,
    );
  }
  if (access !== "write") {
    refuse(
      `${spec}: this stage has ${access} access to the code checkout (${dir}/); it may not commit there`,
    );
  }
  return rest.join("/") || ".";
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

// The plan for one call of `pipeline_commit` with git commit's `args`, in a
// session that may commit what `scope` allows, the commit ending with the
// trailer `trailer` (none when null). A call that names no pathspecs commits
// all the code checkout's changes.
function planOf(
  args: readonly string[],
  scope: PathScope,
  trailer: string | null,
): CommitPlan {
  const read = readArgs(args);
  const codePaths: string[] = [];
  for (const spec of read.paths) {
    const path = codePathOf(spec, scope);
    if (!matchAny(scope.allowed, path)) {
      refuse(`${spec}: outside the paths this session may commit`);
    }
    codePaths.push(path);
  }
  const { repo } = scope;
  let code: string[] | null = null;
  if (repo.access === "write" && scope.allowed.length > 0) {
    const options = optionsIn(read, repo.dir);
    const commit = ["commit", ...options, ...trailerArgs(trailer)];
    code = withPaths(commit, codePaths);
  }
  return { kind: "commit", code, paths: codePaths, dryRun: read.dryRun };
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
// or the argv to run.
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

export type { CommitPlan, CommitScope, PathScope };
export {
  COMMIT_SCOPE_ENV,
  COMMIT_TOOL,
  commitArgsOf,
  commitEnvOf,
  commitScopeIn,
  PATH_SCOPE,
  sessionTrailer,
};
