// A pipeline root with a local origin, for tests that run the ops CLI against
// real git repos and the fake gh. opsFixture() must run before anything from
// src/ is imported, since the pipeline root is read once, on import.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.ts";
import type { FakeGh } from "./fake-gh.ts";
import { installFakeGh } from "./fake-gh.ts";
import { OPS, runOps, setEnv, sh } from "./ops-run-test-kit.ts";

const BASE = "integration";

// The fixture's repos: the root, the bare origin, the seed clone that commits
// to it, the pipeline's clone, and how to make an issue's worktree.
interface Repos {
  root: string;
  origin: string;
  seed: string;
  clone: string;
  ensureWorktree: (n: number) => void;
}

// The git helpers for the origin, the seed clone and the issue worktrees.
interface GitHelpers {
  worktree: (n: number) => string;
  originRef: (ref: string) => string;
  advanceBase: (file: string, text: string) => string;
  commitIn: (n: number, file: string, text: string, message?: string) => string;
  fetchClone: () => void;
  startBranch: (n: number, file: string, text: string) => string;
  inRebase: (n: number) => boolean;
  worktreeState: (n: number) => { head: string; status: string };
  pushFrom: (n: number) => string;
}

// The fixture: the root, the fake gh, ask() to run one ops request,
// configWith() for a config with extra settings, and the git helpers.
type OpsFixture = GitHelpers & {
  root: string;
  fakeGh: FakeGh;
  ask: (request: object, configFile?: string) => string;
  configWith: (fileName: string, extra: object) => string;
  sh: (command: string) => string;
};

function writeConfig(file: string, extra: object): void {
  const config = {
    repo: "o/r",
    ...credentialConfig("a"),
    allowedUsers: ["a"],
    commands: { test: "true" },
    baseBranch: BASE,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(config));
}

// A bare origin on the base branch with one commit, made through the seed.
function seedOrigin(origin: string, seed: string): void {
  sh(`git init -q --bare -b ${BASE} ${origin}`);
  sh(`git clone -q ${origin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(`cd ${seed} && echo base > f && git add f && git commit -qm base`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
}

function worktreeOf({ root }: Repos, n: number): string {
  return path.join(root, "work", "o__r", `issue-${n}`);
}

// The sha of a ref on origin, or "" when it has none.
function originRefOf({ origin }: Repos, ref: string): string {
  return sh(`git --git-dir ${origin} rev-parse -q --verify ${ref} || true`);
}

// Commits a file on the base branch through the seed clone.
function advanceBaseOf(repos: Repos, file: string, text: string): string {
  const { seed } = repos;
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  sh(`cd ${seed} && printf '${text}\\n' > ${file} && git add ${file}`);
  sh(
    `cd ${seed} && git commit -qm "base ${file}" && git push -q origin HEAD:${BASE}`,
  );
  return originRefOf(repos, BASE);
}

// Commits a file in an issue's worktree; returns the new head.
function commitInOf(
  repos: Repos,
  n: number,
  { file, text, message }: { file: string; text: string; message: string },
): string {
  const wt = worktreeOf(repos, n);
  fs.writeFileSync(path.join(wt, file), `${text}\n`);
  sh(`cd ${wt} && git add ${file} && git commit -qm "${message}"`);
  return sh(`git -C ${wt} rev-parse HEAD`);
}

// Brings the clone's origin/integration up to date with origin.
function fetchCloneOf({ clone }: Repos): void {
  sh(`git -C ${clone} fetch -q origin`);
}

// True while a rebase is stopped in the issue's worktree.
function inRebaseOf(repos: Repos, n: number): boolean {
  const wt = worktreeOf(repos, n);
  return ["rebase-merge", "rebase-apply"].some((dir) => {
    const where = sh(`git -C ${wt} rev-parse --git-path ${dir}`);
    return fs.existsSync(path.resolve(wt, where));
  });
}

// Pushes an issue's worktree head to its branch on origin, as the ops CLI
// would (the clone's pre-push hook admits only it).
function pushFromOf(repos: Repos, n: number): string {
  const target = `HEAD:refs/heads/agent/issue-${n}`;
  sh(
    `ISSUE_PIPELINE_OPS=1 git -C ${worktreeOf(repos, n)} push -qf origin ${target}`,
  );
  return originRefOf(repos, `agent/issue-${n}`);
}

// The git helpers, bound to the fixture's repos.
function gitHelpers(r: Repos): GitHelpers {
  return {
    worktree: (n: number) => worktreeOf(r, n),
    originRef: (ref: string) => originRefOf(r, ref),
    advanceBase: (file: string, text: string) => advanceBaseOf(r, file, text),
    commitIn: (
      n: number,
      file: string,
      text: string,
      message = `edit ${file}`,
    ) => commitInOf(r, n, { file, text, message }),
    fetchClone: () => fetchCloneOf(r),
    // Starts an issue's branch on the current base with one commit of
    // `file`, pushed to origin; returns its head.
    startBranch: (n: number, file: string, text: string): string => {
      fetchCloneOf(r);
      r.ensureWorktree(n);
      commitInOf(r, n, { file, text, message: `edit ${file}` });
      return pushFromOf(r, n);
    },
    inRebase: (n: number) => inRebaseOf(r, n),
    // The worktree's head and `git status --porcelain`.
    worktreeState: (n: number) => ({
      head: sh(`git -C ${worktreeOf(r, n)} rev-parse HEAD`),
      status: sh(`git -C ${worktreeOf(r, n)} status --porcelain`),
    }),
    pushFrom: (n: number) => pushFromOf(r, n),
  };
}

// Makes the fixture, named `name` in its temp folder's name.
async function opsFixture(name: string): Promise<OpsFixture> {
  const root = fs.mkdtempSync(`/tmp/issue-pipeline-${name}-`);
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  setEnv("ISSUE_PIPELINE_ROOT", root);
  setEnv("HOME", home);
  const pipelineRoot = await import("../src/pipeline-root.ts");
  if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== home) {
    throw new Error("src took a pipeline root outside the fixture's folder");
  }
  const fakeGh = installFakeGh();
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  seedOrigin(origin, seed);
  const config = path.join(root, "config.json");
  writeConfig(config, { cloneUrl: origin });
  const { loadConfig } = await import("../src/config.ts");
  const { ensureClone, ensureWorktree } = await import("../src/checkouts.ts");
  const cfg = loadConfig(config);
  const clone = ensureClone(cfg);
  const repos: Repos = {
    root,
    origin,
    seed,
    clone,
    ensureWorktree: (n: number) => {
      ensureWorktree(cfg, n);
    },
  };
  return {
    root,
    fakeGh,
    // The raw stdout of one ops request, framed as the workflow frames it.
    ask: (request: object, configFile = config) =>
      runOps({ config: configFile, request, root }),
    // A config file with extra settings.
    configWith: (fileName: string, extra: object): string => {
      const file = path.join(root, fileName);
      writeConfig(file, { cloneUrl: origin, ...extra });
      return file;
    },
    sh,
    ...gitHelpers(repos),
  };
}

// The stdout the ops CLI prints for a successful op's reply that posted no
// comments: no count and no comment ids.
function okLine(op: string, reply: object): string {
  return `${JSON.stringify({ ok: true, op, posted: 0, commentIds: [], ...reply })}\n`;
}

// True when src/ops.ts still defines the handler itself: names the op as a
// string literal, as a Map entry does, or assigns it as `ops["x"] =` or
// `ops.x =`.
function opsSourceDefines(name: string): boolean {
  const source = fs.readFileSync(OPS, "utf8");
  return source.includes(`"${name}"`) || source.includes(`ops.${name} =`);
}

// The gh call that reads an issue's saved state, as a push does before it
// pushes code: the issue's comments, where a codeMerged would refuse it.
function stateReadCall(n: number): string[] {
  return [
    "api",
    "--paginate",
    `repos/o/r/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ];
}

export type { OpsFixture };
export { okLine, opsFixture, opsSourceDefines, stateReadCall };
