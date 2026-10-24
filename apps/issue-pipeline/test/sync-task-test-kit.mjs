// @ts-check
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
import { BASE, bareGit } from "./pipeline-flow-test-kit.mjs";
import {
  plantComment,
  rawOps,
  stateText,
  taskWorld,
  v2State,
} from "./task-results-test-kit.mjs";

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

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function gitIn(dir, args) {
  return execFileSync(REAL_GIT, ["-C", dir, ...ID, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...Object.fromEntries([["GIT_ALLOW_PROTOCOL", "file"]]),
    },
  }).trim();
}

/** @param {string} dir @param {string} file @param {string | Buffer} bytes @param {string} message @returns {string} the new head */
function commitFile(dir, file, bytes, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), bytes);
  gitIn(dir, ["add", "--", file]);
  gitIn(dir, ["commit", "-qm", message]);
  return gitIn(dir, ["rev-parse", "HEAD"]);
}

/**
 * Issue `issue` at revision R on its branch, beside a target the test moves.
 * `mine` is the branch's own change, as file and bytes; `before` prepares the
 * target's base commit in a writer clone before the branch forks from it.
 * @param {number} issue
 * @param {{ file: string, bytes: string | Buffer }} mine
 * @param {(writer: string) => void} [before]
 */
function syncWorld(issue, mine, before) {
  const { flow } = taskWorld(issue);
  const branch = `agent/issue-${issue}`;
  plantComment(
    flow.ghDir,
    issue,
    "bot",
    stateText(v2State(issue, { stage: "merge", branch })),
  );
  const clone = path.join(flow.root, "clones", SLUG);
  const wt = path.join(flow.root, "work", SLUG, `issue-${issue}`);
  const writer = path.join(flow.tmp, "base-writer");
  execFileSync(REAL_GIT, ["clone", "-q", flow.origin, writer]);
  if (before !== undefined) {
    before(writer);
    gitIn(writer, ["push", "-q", "origin", `HEAD:refs/heads/${BASE}`]);
  }
  for (const dir of [clone, wt]) {
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
  /** The issue's current revision, read again after the config changes. */
  function readCurrent() {
    return REVISION.parse(
      rawOps(flow, { op: "current-revision", number: issue }),
    );
  }
  let current = readCurrent();
  /** Sets top-level config `settings`, then reads the new policy. @param {Record<string, unknown>} settings */
  function configure(settings) {
    const saved = JSON.parse(fs.readFileSync(flow.config, "utf8"));
    fs.writeFileSync(flow.config, JSON.stringify({ ...saved, ...settings }));
    current = readCurrent();
  }
  /** Sets the configured test command. @param {string} command */
  function setCheck(command) {
    const { commands } = JSON.parse(fs.readFileSync(flow.config, "utf8"));
    configure({ commands: { ...commands, test: command } });
  }
  /** Moves the target with `file` set to `bytes`, returning the new T. @param {string} file @param {string | Buffer} bytes */
  function advanceTarget(file, bytes) {
    const head = commitFile(writer, file, bytes, `target changes ${file}`);
    gitIn(writer, ["push", "-q", "origin", `HEAD:refs/heads/${BASE}`]);
    return head;
  }
  /** The Sync binding of R onto `target`. @param {string} target @param {string} [code] */
  function binding(target, code = revision) {
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
  /** One Sync op's reply. @param {string} op @param {object} fields */
  function sync(op, fields) {
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
    /** @returns {string | null} the branch's head on origin */
    remoteBranch: () => refOf(flow.origin, `refs/heads/${branch}`),
    /** @returns {string | null} the target's head on origin */
    remoteTarget: () => refOf(flow.origin, `refs/heads/${BASE}`),
  };
}

/** @param {string} origin @param {string} ref @returns {string | null} */
function refOf(origin, ref) {
  try {
    return bareGit(origin, ["rev-parse", "--verify", "--quiet", ref]);
  } catch {
    return null;
  }
}

/** @param {string} origin @param {string} ancestor @param {string} commit @returns {boolean} */
function originContains(origin, ancestor, commit) {
  try {
    bareGit(origin, ["merge-base", "--is-ancestor", ancestor, commit]);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} wt @returns {boolean} */
function inRebase(wt) {
  const dir = gitIn(wt, ["rev-parse", "--git-dir"]);
  const gitDir = path.resolve(wt, dir);
  return ["rebase-merge", "rebase-apply"].some((name) =>
    fs.existsSync(path.join(gitDir, name)),
  );
}

/** @param {string} wt @returns {string} the unmerged index, as git lists it */
function unmerged(wt) {
  return gitIn(wt, ["ls-files", "--unmerged"]);
}

/**
 * Makes the next push through PATH's git `refuse` (nothing lands) or
 * `lose-reply` (the push lands, but git reports a failure). Later pushes run
 * normally.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 * @param {"refuse" | "lose-reply"} mode
 */
function faultNextPush(flow, mode) {
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

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow @param {number} issue @returns {string[]} the run folder's recovery entries */
function recoveryOf(flow, issue) {
  const dir = path.join(flow.root, "runs", SLUG, `issue-${issue}`, "recovery");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .flatMap((entry) => fs.readdirSync(path.join(dir, entry)));
}

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
