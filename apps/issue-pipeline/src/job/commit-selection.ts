// Resolve explicit selections before either checkout is mutated. Git expands
// directories and patterns read-only; authority is checked on every concrete
// path, not on the pattern. Execution then uses literal paths exclusively.
import fs from "node:fs";
import path from "node:path";
import { matchAny } from "../globs.ts";
import { run } from "../process.ts";
import { refuse } from "./commit-options.ts";
import type { CommitScope } from "./commit-scope.ts";
import type { CommitPlan } from "./pipeline-commit.ts";

const READ_ONLY_ENV = new Map([["GIT_OPTIONAL_LOCKS", "0"]]);

type Planned = Extract<CommitPlan, { kind: "commit" }>;
interface PreparedCommit {
  code: string[][] | null;
  wiki: string[][] | null;
  dryRun: boolean;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function inCheckout(root: string, target: string): boolean {
  if (
    !inside(root, target) ||
    path.relative(root, target).split(path.sep).includes(".git")
  ) {
    return false;
  }
  let current = target;
  while (current !== root) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return false;
    }
    current = path.dirname(current);
  }
  return true;
}

// Inspect each existing component, including dangling symlinks and links
// through directories. A nonexistent leaf (such as a deletion) is valid.
function checkPath(dir: string, file: string): void {
  const root = fs.realpathSync(dir);
  let current = root;
  for (const segment of file.split("/")) {
    if (segment === ".git" || segment === ".." || segment.includes("\0")) {
      refuse(`${file}: metadata or parent paths may not be committed`);
    }
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.realpathSync(current);
      } catch {
        refuse(`${file}: unresolved symlink in selection`);
      }
      if (!inCheckout(root, target)) {
        refuse(`${file}: selection escapes checkout through a symlink`);
      }
    }
  }
}

function selectedPaths(
  dir: string,
  specs: string[],
  allowed: readonly string[] | null,
): string[] {
  for (const spec of specs) {
    checkPath(dir, spec);
  }
  const result = run(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...specs,
    ],
    { cwd: dir, env: READ_ONLY_ENV },
  );
  const paths = [...new Set(result.stdout.split("\0").filter(Boolean))];
  for (const file of paths) {
    checkPath(dir, file);
    if (allowed !== null && !matchAny(allowed, file)) {
      refuse(`${file}: outside the paths this session may commit`);
    }
  }
  return paths;
}

function prepareCheckout(
  dir: string,
  commands: string[][],
  allowed: readonly string[] | null,
): string[][] {
  const commit = commands.find((argv) => argv[0] === "commit");
  if (commit === undefined) {
    throw new Error("missing commit command");
  }
  const separator = commit.indexOf("--");
  if (separator < 0) {
    if (allowed !== null) {
      const changed = run("git", ["diff", "--name-only", "-z", "HEAD"], {
        cwd: dir,
        env: READ_ONLY_ENV,
      });
      for (const file of changed.stdout.split("\0").filter(Boolean)) {
        checkPath(dir, file);
        if (!matchAny(allowed, file)) {
          refuse(`${file}: outside the paths this session may commit`);
        }
      }
    }
    return commands;
  }
  const specs = commit.slice(separator + 1);
  const paths = selectedPaths(dir, specs, allowed);
  if (paths.length === 0) {
    // No selection may fall back to a blanket add or an index-only commit.
    return refuse(`${specs.join(", ")}: selection matches no files`);
  }
  const literal = [
    "--literal-pathspecs",
    ...commit.slice(0, separator),
    "--",
    ...paths,
  ];
  return [["--literal-pathspecs", "add", "-A", "--", ...paths], literal];
}

function prepareCommit(plan: Planned, scope: CommitScope): PreparedCommit {
  let code: string[][] | null = null;
  let wiki: string[][] | null = null;
  if (plan.code !== null) {
    code = prepareCheckout(
      path.join(scope.root, scope.repo.dir),
      [plan.code],
      scope.allowed,
    );
  }
  if (plan.wiki !== null && scope.docs !== null) {
    wiki = prepareCheckout(
      path.join(scope.root, scope.docs.dir),
      plan.wiki,
      null,
    );
  }
  return { code, wiki, dryRun: plan.dryRun };
}

export type { PreparedCommit };
export { prepareCommit };
