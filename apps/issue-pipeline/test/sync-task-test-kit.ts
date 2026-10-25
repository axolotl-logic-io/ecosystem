// The Sync task's world (#184): the task-result world (task-results-test-kit)
// with issue `n` checked out as the pipeline keeps it, the shared clone and
// the issue's worktree on agent/issue-<n> at revision R, a saved state, and a
// target T that R doesn't contain. Every op runs as a fresh built ops process.
// A `git` wrapper first on PATH can refuse the next push or lose its reply.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { openIssue } from "./fake-pipeline-flow-gh.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { BASE, bareGit } from "./pipeline-flow-test-kit.ts";
import {
  plantComment,
  rawOps,
  stateText,
  taskWorld,
  v2State,
} from "./task-results-test-kit.ts";

const SLUG = "o__r";
const ID = ["-c", "user.name=Dev", "-c", "user.email=dev@example.com"];
const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();
const REVISION = z.looseObject({
  revision: z.looseObject({ inputs: z.string(), policy: z.string() }),
});
const SYNC_REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  ready: z.boolean().optional(),
  reason: z.string().optional(),
  conflict: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  verdict: z.enum(["passed", "failed"]).optional(),
  produced: z.string().optional(),
  retained: z.boolean().optional(),
  settled: z.union([z.literal(false), z.enum(["passed", "failed"])]).optional(),
});

type SyncReply = z.infer<typeof SYNC_REPLY>;

// A task's binding: revision R of the work item, and the target it runs on.
interface TaskBinding {
  repo: string;
  workItem: number;
  task: string;
  revision: { code: string; inputs: string; policy: string };
  target: { branch: string; commit: string };
}

// The Sync world of one issue (syncWorld): its flow, worktree, branch, base
// T it forked from (`start`), revision R and the writer clone that moves
// the target, with the ops a test runs in it.
interface SyncWorld {
  flow: Flow;
  wt: string;
  branch: string;
  start: string;
  revision: string;
  writer: string;
  advanceTarget: (file: string, bytes: string | Buffer) => string;
  binding: (target: string, code?: string) => TaskBinding;
  configure: (settings: Record<string, unknown>) => void;
  setCheck: (command: string) => void;
  sync: (op: string, fields: object) => SyncReply;
  remoteBranch: () => string | null;
  remoteTarget: () => string | null;
}

function gitIn(dir: string, args: readonly string[]): string {
  return execFileSync(REAL_GIT, ["-C", dir, ...ID, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...Object.fromEntries([["GIT_ALLOW_PROTOCOL", "file"]]),
    },
  }).trim();
}

// Returns the new head
function commitFile(
  dir: string,
  file: string,
  bytes: string | Buffer,
  message: string,
): string {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), bytes);
  gitIn(dir, ["add", "--", file]);
  gitIn(dir, ["commit", "-qm", message]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

// Issue `issue` at revision R on its branch, beside a target the test moves.
// `mine` is the branch's own change, as file and bytes; `before` prepares the
// target's base commit in a writer clone before the branch forks from it.
// shared: another issue's flow to add this one to
function syncWorld(
  issue: number,
  mine: { file: string; bytes: string | Buffer },
  before?: (writer: string) => void,
  shared?: Flow | undefined,
): SyncWorld {
  const flow = shared ?? taskWorld(issue).flow;
  if (shared !== undefined) {
    openIssue(flow.ghDir, {
      number: issue,
      title: "Task results",
      body: `Issue ${issue}'s change.`,
      login: "alice",
    });
  }
  const branch = `agent/issue-${issue}`;
  plantComment(
    flow.ghDir,
    issue,
    "bot",
    stateText(v2State(issue, { stage: "merge", branch })),
  );
  const clone = path.join(flow.root, "clones", SLUG);
  const wt = path.join(flow.root, "work", SLUG, `issue-${issue}`);
  const writer = path.join(flow.tmp, `base-writer-${issue}`);
  execFileSync(REAL_GIT, ["clone", "-q", flow.origin, writer]);
  if (before !== undefined) {
    before(writer);
    gitIn(writer, ["push", "-q", "origin", `HEAD:refs/heads/${BASE}`]);
  }
  for (const dir of [clone, wt].filter((each) => !fs.existsSync(each))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync(REAL_GIT, [
      "clone",
      "-q",
      "--no-recurse-submodules",
      flow.origin,
      dir,
    ]);
  }
  gitIn(wt, ["checkout", "-qb", branch]);
  gitIn(wt, ["config", "user.name", "Pipeline"]);
  gitIn(wt, ["config", "user.email", "pipeline@example.com"]);
  const start = gitIn(wt, ["rev-parse", "HEAD"]);
  const revision = commitFile(wt, mine.file, mine.bytes, "the issue's change");
  gitIn(wt, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  //  The issue's current revision, read again after the config changes.
  function readCurrent(): {
    [x: string]: unknown;
    revision: { [x: string]: unknown; inputs: string; policy: string };
  } {
    return REVISION.parse(
      rawOps(flow, { op: "current-revision", number: issue }),
    );
  }
  let current = readCurrent();
  //  Sets top-level config `settings`, then reads the new policy.
  function configure(settings: Record<string, unknown>): void {
    const saved = JSON.parse(fs.readFileSync(flow.config, "utf8"));
    fs.writeFileSync(flow.config, JSON.stringify({ ...saved, ...settings }));
    current = readCurrent();
  }
  //  Sets the configured test command.
  function setCheck(command: string): void {
    const { commands } = JSON.parse(fs.readFileSync(flow.config, "utf8"));
    configure({ commands: { ...commands, test: command } });
  }
  //  Moves the target with `file` set to `bytes`, returning the new T.
  function advanceTarget(file: string, bytes: string | Buffer): string {
    const head = commitFile(writer, file, bytes, `target changes ${file}`);
    gitIn(writer, ["push", "-q", "origin", `HEAD:refs/heads/${BASE}`]);
    return head;
  }
  //  The Sync binding of R onto `target`.
  function binding(target: string, code: string = revision): TaskBinding {
    return {
      repo: "o/r",
      workItem: issue,
      task: "Sync",
      revision: {
        code,
        inputs: current.revision.inputs,
        policy: current.revision.policy,
      },
      target: { branch: BASE, commit: target },
    };
  }
  //  One Sync op's reply.
  function sync(op: string, fields: object): SyncReply {
    return SYNC_REPLY.parse(rawOps(flow, { op, number: issue, ...fields }));
  }
  return {
    flow,
    wt,
    branch,
    start,
    revision,
    writer,
    advanceTarget,
    binding,
    configure,
    setCheck,
    sync,
    // Returns the branch's head on origin
    remoteBranch: (): string | null =>
      refOf(flow.origin, `refs/heads/${branch}`),
    // Returns the target's head on origin
    remoteTarget: (): string | null => refOf(flow.origin, `refs/heads/${BASE}`),
  };
}

function refOf(origin: string, ref: string): string | null {
  try {
    return bareGit(origin, ["rev-parse", "--verify", "--quiet", ref]);
  } catch {
    return null;
  }
}

function originContains(
  origin: string,
  ancestor: string,
  commit: string,
): boolean {
  try {
    bareGit(origin, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

function inRebase(wt: string): boolean {
  const dir = gitIn(wt, ["rev-parse", "--git-dir"]);
  const gitDir = path.resolve(wt, dir);
  return ["rebase-merge", "rebase-apply"].some((name) =>
    fs.existsSync(path.join(gitDir, name)),
  );
}

// Returns the unmerged index, as git lists it
function unmerged(wt: string): string {
  return gitIn(wt, ["ls-files", "--unmerged"]);
}

// Makes the next push through PATH's git `refuse` (nothing lands) or
// `lose-reply` (the push lands, but git reports a failure). Later pushes run
// normally.
function faultNextPush(flow: Flow, mode: "refuse" | "lose-reply"): void {
  const bin = path.join(flow.tmp, "bin");
  const marker = path.join(flow.tmp, "push-fault");
  fs.writeFileSync(marker, mode);
  const wrapper = `#!/usr/bin/env bash
marker=${JSON.stringify(marker)}
if [[ " $* " == *" push "* && -f "$marker" ]]; then
  mode=$(cat "$marker"); rm -f "$marker"
  if [[ "$mode" == "lose-reply" ]]; then ${JSON.stringify(REAL_GIT)} "$@" >/dev/null 2>&1; fi
  echo "fatal: the remote end hung up unexpectedly" >&2; exit 128
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`;
  fs.writeFileSync(path.join(bin, "git"), wrapper, { mode: 0o755 });
}

// Returns the run folder's recovery entries
function recoveryOf(flow: Flow, issue: number): string[] {
  const dir = path.join(flow.root, "runs", SLUG, `issue-${issue}`, "recovery");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .flatMap((entry) => fs.readdirSync(path.join(dir, entry)));
}

export type { SyncReply, SyncWorld, TaskBinding };
export {
  commitFile,
  faultNextPush,
  gitIn,
  inRebase,
  originContains,
  recoveryOf,
  syncWorld,
  unmerged,
};
