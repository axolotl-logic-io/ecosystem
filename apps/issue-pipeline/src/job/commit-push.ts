// The job's side of `pipeline_commit` (Pipeline-Roles-Shared, "Push"): after
// a writer session commits, the job, which alone holds the token, pushes the
// checkout's code commits that origin lacks to the issue's branch, and the
// wiki checkout's when the stage writes the wiki, and records each push under
// the session's launch in job.json and as a line of `pushes.jsonl` in the
// issue's run folder, `{key, job, repo, sha, at}`, which outlives job.json.
// It pushes only for a launch of the job recorded as given commit authority,
// so a read-only session that reached the socket pushes nothing.
// It defers while a rebase is stopped in
// either checkout, whose ops push the rebased branch only after its checks.
// A refused push keeps the commits and is reported, never thrown; the next
// request pushes whatever is still unpushed.

import { pushHead } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { run } from "../process.ts";
import { rebaseInProgress } from "../rebase.ts";
import type { Stage } from "../stages.ts";
import { pushWikiBranch } from "../wiki.ts";
import type { Pushed, PushReply } from "./control-protocol.ts";
import type { LaunchPush } from "./launch-record.ts";
import { STAGE_WIKI_ACCESS } from "./roles.ts";
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

// The push request handler of `job`, which records each push in `status`
// and refuses a key whose launch `status` doesn't record as committing.
// Synchronous, so the job answers one request at a time.
function pushServerOf(
  cfg: Config,
  job: PushJob,
  status: Pick<JobStatus, "pushed" | "launch">,
): (key: string) => PushReply {
  const { issue, stage, checkout, branch } = job;
  const runDir = paths.runDir(cfg, issue);
  const jobCfg = withCheckout(cfg, { issue, dir: checkout, branch });
  const wikiDir = paths.wiki(jobCfg, issue);
  const writesWiki =
    STAGE_WIKI_ACCESS[stage] === "write" && wikiCfg(cfg) !== null;
  return (key: string): PushReply => {
    if (status.launch(key)?.commits !== true) {
      const pushError = `${key} is no session of this job that commits`;
      return { pushed: "none", pushError };
    }
    const rebasing = [checkout, wikiDir].some(
      (dir) => isRepo(dir) && rebaseInProgress(dir),
    );
    if (rebasing) {
      return { pushed: "deferred", pushError: null };
    }
    const done: { pushes: LaunchPush[]; errors: string[] } = {
      pushes: [],
      errors: [],
    };
    const code = pushRepo(
      checkout,
      "code",
      (): void => {
        pushHead(jobCfg, issue, PIPELINE_COMMIT_OP);
      },
      done,
    );
    let wiki = false;
    if (writesWiki) {
      wiki = pushRepo(
        wikiDir,
        "wiki",
        (): void => {
          pushWikiBranch(jobCfg, issue);
        },
        done,
      );
    }
    for (const push of done.pushes) {
      status.pushed(key, push);
      appendRunLine(runDir, "pushes.jsonl", { key, job: job.id, ...push });
    }
    let pushError: string | null = null;
    if (done.errors.length > 0) {
      pushError = done.errors.join("\n");
    }
    return { pushed: pushedOf(code, wiki), pushError };
  };
}

export type { PushJob };
export { PIPELINE_COMMIT_OP, pushServerOf };
