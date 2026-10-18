// The job's side of `pipeline_commit` (Pipeline-Roles-Shared, "Push"): after
// a writer session commits, the job, which alone holds the token, pushes the
// checkout's code commits that origin lacks to the issue's branch, and the
// wiki checkout's when the stage writes the wiki, and records each push under
// the session's launch in job.json and as a line of `pushes.jsonl` in the
// issue's run folder, `{key, job, repo, sha, at}`, which outlives job.json.
// Only a launch with a job-bound write scope can push. Fresh saved receipts
// and live PR authority independently forbid code after merge, even when a
// session forges its tool environment. Wiki writes keep their bound scope.
// It defers while a rebase is stopped in
// either checkout, whose ops push the rebased branch only after its checks.
// A refused push keeps the commits and is reported, never thrown; the next
// request rechecks authority for whatever is still unpushed.

import { pushHead } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import { run } from "../process.ts";
import { rebaseInProgress } from "../rebase.ts";
import type { Stage } from "../stages.ts";
import { pushWikiBranch } from "../wiki.ts";
import { readWriteAuthority } from "../write-authority.ts";
import type { Pushed, PushReply } from "./control-protocol.ts";
import type { LaunchPush } from "./launch-record.ts";
import type { PathScope } from "./pipeline-commit.ts";
import { appendRunLine } from "./run-log.ts";
import type { JobStatus } from "./status.ts";

// The op a push for `pipeline_commit` is recorded as in pushed.json, which a
// claim adopts as the pipeline's own push (src/adopt-push.ts).
const PIPELINE_COMMIT_OP = "pipeline-commit";
// The job a push server pushes for: its code checkout, the issue branch its
// caller assigned, and its random id.
interface PushJob {
  issue: number;
  stage: Stage;
  checkout: string;
  branch: string;
  id: string;
}

function isRepo(dir: string): boolean {
  const args = ["-C", dir, "rev-parse", "--is-inside-work-tree"];
  return run("git", args, { allowFail: true }).code === 0;
}

// The head of `dir` when it has commits no origin branch has, else null.
function unpushedHead(dir: string): string | null {
  if (!isRepo(dir)) {
    return null;
  }
  const range = ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"];
  const ahead = Number(run("git", ["-C", dir, ...range]).stdout.trim());
  if (!(ahead > 0)) {
    return null;
  }
  return run("git", ["-C", dir, "rev-parse", "HEAD"]).stdout.trim();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function pushedOf(code: boolean, wiki: boolean): Pushed {
  if (code && wiki) {
    return "both";
  }
  if (code) {
    return "code";
  }
  if (wiki) {
    return "wiki";
  }
  return "none";
}

// Runs `push` when `dir` holds unpushed commits, recording the head pushed
// as `repo`'s. True when it pushed; a failure is added to `errors`.
function pushRepo(
  dir: string,
  repo: LaunchPush["repo"],
  push: () => void,
  done: { pushes: LaunchPush[]; errors: string[] },
): boolean {
  try {
    const sha = unpushedHead(dir);
    if (sha === null) {
      return false;
    }
    push();
    done.pushes.push({ repo, sha, at: new Date().toISOString() });
    return true;
  } catch (error: unknown) {
    done.errors.push(`${repo} push failed: ${messageOf(error)}`);
    return false;
  }
}

// Pushes only the launch's bound checkouts, under fresh saved authority.
function pushSession(
  cfg: Config,
  job: PushJob,
  session: { key: string; scope: PathScope },
  status: Pick<JobStatus, "pushed">,
): PushReply {
  const { key, scope } = session;
  const { issue } = job;
  const wikiDir = paths.wiki(cfg, issue);
  const done: { pushes: LaunchPush[]; errors: string[] } = {
    pushes: [],
    errors: [],
  };
  const code = pushRepo(
    job.checkout,
    "code",
    (): void => {
      // Re-read at the credentialed mutation, not just at launch or request
      // entry. A saved own-merge receipt closes the pre-claim window too.
      const { codeWritable } = readWriteAuthority(cfg, issue);
      if (!codeWritable || scope.repo.access !== "write") {
        throw new Error(
          "code is merged or read-only; local commits kept for operator recovery",
        );
      }
      pushHead(cfg, issue, PIPELINE_COMMIT_OP);
    },
    done,
  );
  let wiki = false;
  if (scope.docs?.access === "write") {
    wiki = pushRepo(
      wikiDir,
      "wiki",
      (): void => {
        readWriteAuthority(cfg, issue);
        pushWikiBranch(cfg, issue);
      },
      done,
    );
  }
  for (const push of done.pushes) {
    status.pushed(key, push);
    appendRunLine(paths.runDir(cfg, issue), "pushes.jsonl", {
      key,
      job: job.id,
      ...push,
    });
  }
  let pushError: string | null = null;
  if (done.errors.length > 0) {
    pushError = done.errors.join("\n");
  }
  return { pushed: pushedOf(code, wiki), pushError };
}

// The push request handler of `job`, which records each push in `status`
// and refuses a key whose launch `status` doesn't record as committing.
// Synchronous, so the job answers one request at a time.
function pushServerOf(
  cfg: Config,
  job: PushJob,
  status: Pick<JobStatus, "pushed" | "launch">,
): (key: string) => PushReply {
  const { issue, checkout, branch } = job;
  const jobCfg = withCheckout(cfg, { issue, dir: checkout, branch });
  const wikiDir = paths.wiki(jobCfg, issue);
  return (key: string): PushReply => {
    const launch = status.launch(key);
    if (launch?.kind !== "session" || launch.commits !== true) {
      const pushError = `${key} is no session of this job that commits`;
      return { pushed: "none", pushError };
    }
    const { scope } = launch;
    if (scope === null) {
      return { pushed: "none", pushError: `${key} has no bound write scope` };
    }
    // No request fields or session environment supply this authority. Failure
    // to confirm saved state refuses both checkouts, rather than guessing.
    try {
      readWriteAuthority(jobCfg, issue);
    } catch (error: unknown) {
      return { pushed: "none", pushError: messageOf(error) };
    }
    const rebasing = [checkout, wikiDir].some(
      (dir) => isRepo(dir) && rebaseInProgress(dir),
    );
    if (rebasing) {
      return { pushed: "deferred", pushError: null };
    }
    return pushSession(jobCfg, job, { key, scope }, status);
  };
}

export type { PushJob };
export { PIPELINE_COMMIT_OP, pushServerOf };
