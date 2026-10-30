// Implement, as a task app on the task app framework:
//
//   node implement.mjs --config BUDDY_FILE --issue OWNER/REPO#N
//
// Only `start:implement` starts it. Its work writes the change the issue
// asks for on the branch `agent/issue-N`, hardens it in a fresh session and
// marks the issue's pull request (PR) ready. It continues earlier work from
// GitHub alone: it starts from the branch's head when the branch exists,
// pushes every commit as it is made, opens the PR early as a draft with
// `Closes #N` and reuses the PR that exists. Its sessions read the issue,
// its comments, the latest Gherkin and the PR's discussion.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { PushReply } from "@ecosystem/task-runtime/job/control-protocol";
import type { InvocationBinding } from "@ecosystem/task-runtime/job/session-identity";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import { run as runProcess } from "../process.ts";
import {
  type BranchCheckout,
  openBranchCheckout,
  type Pushed,
} from "../task-app/branch-checkout.ts";
import { issueBrief } from "../task-app/issue-brief.ts";
import type { PullRequest } from "../task-app/recovery.ts";
import { taskRunFile } from "../task-app/run-record.ts";
import { openSessions, type Sessions } from "../task-app/sessions.ts";
import { main, type TaskRun } from "../task-app/task-app.ts";
import { WRITER_REPLY } from "./replies.ts";

const TASK = "implement";
const COMMIT_ENV: ReadonlyMap<string, string> = new Map([
  ["ISSUE_PIPELINE_COMMIT", "1"],
  ["GIT_EDITOR", "true"],
]);

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function titleFor(issue: number, title: string): string {
  if (new RegExp(`#${issue}\\b`, "u").test(title)) {
    return title;
  }
  return `${title} (#${issue})`;
}

// The PR this run works on, before any work: the open PR from the branch,
// made a draft, or none yet. A merged or closed PR is a person's call.
function reusablePull(run: TaskRun): PullRequest | null {
  const pull = run.recovery.pullRequest();
  if (pull === null) {
    return null;
  }
  if (pull.state === "MERGED") {
    throw new OpsError(
      `PR #${pull.number} from \`${pull.head}\` already merged, so Implement changes nothing more for this issue`,
    );
  }
  if (pull.state !== "OPEN") {
    throw new OpsError(
      `PR #${pull.number} from \`${pull.head}\` is closed. To continue on it, reopen it and apply \`start:implement\` again`,
    );
  }
  return pull;
}

function published(pushed: Pushed): string {
  if (pushed.kind === "diverged") {
    throw new OpsError(
      `the issue's branch holds commits this run's checkout lacks, so nothing was overwritten; this run's work is on \`${pushed.recovery}\` at ${pushed.head}`,
    );
  }
  return pushed.head;
}

// Pushes the branch, with an empty first commit when it has nothing ahead
// of the base, so a PR can be opened on it before any code is written.
function publishBranch(checkout: BranchCheckout, issue: number): string {
  if (checkout.ahead() === 0) {
    runProcess(
      "git",
      [
        "-C",
        checkout.dirs.repo,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        `Start work on #${issue}`,
      ],
      { env: COMMIT_ENV },
    );
  }
  return published(checkout.push());
}

// The issue's open PR, as a draft: `found`, or one opened now.
function draftPull(
  run: TaskRun,
  cfg: Config,
  found: PullRequest | null,
): PullRequest {
  const { repo, number } = run.issue;
  if (found === null) {
    const { title } = run.recovery.issue();
    run.github.change([
      "pr",
      "create",
      "-R",
      repo,
      "--base",
      cfg.baseBranch,
      "--head",
      `agent/issue-${number}`,
      "--title",
      titleFor(number, title),
      "--body",
      `Closes #${number}`,
      "--draft",
    ]);
  } else if (!found.isDraft) {
    run.github.change([
      "pr",
      "ready",
      String(found.number),
      "-R",
      repo,
      "--undo",
    ]);
  }
  const pull = run.recovery.pullRequest();
  if (pull?.state !== "OPEN" || !pull.isDraft) {
    throw new OpsError(
      "the issue's draft PR couldn't be confirmed on GitHub; apply `start:implement` again to continue",
    );
  }
  return pull;
}

// The facts each session's task gives: what it is, where the issue and the
// code are, and what earlier work it continues.
function sessionTask(
  run: TaskRun,
  setting: { cfg: Config; brief: string; pull: number; continues: boolean },
  kind: "development" | "hardening",
): string {
  const { cfg, brief, pull, continues } = setting;
  const { repo, number } = run.issue;
  const base = `origin/${cfg.baseBranch}`;
  const lines = [
    `# Issue #${number} in ${repo}: \`${kind}\``,
    "",
    `- Task: \`${kind}\``,
    `- Issue file: \`${brief}\``,
    `- Code checkout: \`repo/\`, on branch \`agent/issue-${number}\``,
    `- Target branch: \`${cfg.baseBranch}\``,
    `- Pull request: #${pull}, a draft until hardening is done`,
    "",
    "## Configured full check",
    "",
    `commands.test: ${JSON.stringify(cfg.commands.test)}`,
    "",
  ];
  if (kind === "hardening") {
    lines.push(
      "## Hardening",
      "",
      "This is a fresh session. The writing session's conversation is not given to you; judge the code on the branch.",
      "",
      `The change against the base: \`git -C repo diff ${base}...HEAD\``,
      "",
    );
  } else if (continues) {
    lines.push(
      "## Continue existing work",
      "",
      "The branch already holds work on this issue from an earlier run. The issue file holds its comments and its PR's discussion.",
      `Inspect the branch before editing: \`git -C repo log ${base}..HEAD\` and \`git -C repo diff ${base}...HEAD\`.`,
      "Continue what is unfinished. Keep correct existing work; do not restart from the base or reset the branch.",
      "",
    );
  }
  return lines.join("\n");
}

// Runs one writer session, and returns its summary. A session that fails
// or can't finish throws, and one that `agents:stop` ended throws Stopped.
async function written(
  run: TaskRun,
  sessions: Sessions,
  kind: "development" | "hardening",
  task: string,
): Promise<string> {
  let page = "developer.md";
  let phase: "hardening" | null = null;
  if (kind === "hardening") {
    page = "developer-hardening.md";
    phase = "hardening";
  }
  const session = await sessions.run({
    profile: "developer",
    page,
    phase,
    task,
    schema: WRITER_REPLY,
    commits: true,
  });
  run.checkStop();
  if (!session.ok) {
    throw new OpsError(`the ${kind} session failed: ${session.error}`);
  }
  const reply = WRITER_REPLY.parse(session.reply);
  if (reply.outcome === "cannot") {
    throw new OpsError(`the ${kind} session could not finish: ${reply.reason}`);
  }
  return reply.summary;
}

// What a session's `pipeline_commit` hears of its push. While
// `agents:stop` is on the issue nothing is pushed and the sessions are
// asked to abort; the commits stay in the checkout.
function pusher(
  run: TaskRun,
  checkout: BranchCheckout,
  sessions: () => Sessions | null,
): () => PushReply {
  return (): PushReply => {
    if (run.github.stopped()) {
      sessions()?.abort();
      return { pushed: "none", pushError: "`agents:stop` is on the issue" };
    }
    try {
      const pushed = checkout.push();
      if (pushed.kind === "diverged") {
        return {
          pushed: "none",
          pushError: `the branch moved; this work is on ${pushed.recovery}`,
        };
      }
      if (pushed.kind === "current") {
        return { pushed: "none", pushError: null };
      }
      return { pushed: "code", pushError: null };
    } catch (error: unknown) {
      return { pushed: "none", pushError: String(error) };
    }
  };
}

async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  if (!same(run.account, cfg.devAccount)) {
    throw new OpsError(
      `Implement pushes code as the repository's development account @${cfg.devAccount}, and this buddy is @${run.account}`,
    );
  }
  const { number, repo } = run.issue;
  const found = reusablePull(run);
  const continues = found !== null || run.recovery.branch() !== null;
  const folder = path.dirname(taskRunFile(repo, number, run.run));
  const checkout = openBranchCheckout(cfg, number, run.run);
  let sessions: Sessions | null = null;
  try {
    run.checkStop();
    publishBranch(checkout, number);
    const pull = draftPull(run, cfg, found);
    const brief = path.join(folder, "issue.md");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(brief, issueBrief(run, cfg.baseBranch, pull));
    const binding: InvocationBinding = {
      instance: run.run,
      lane: TASK,
      issue: number,
      branch: `agent/issue-${number}`,
      repo,
      base: cfg.baseBranch,
    };
    sessions = await openSessions(cfg, {
      dir: folder,
      checkout: checkout.dirs,
      binding,
      push: pusher(run, checkout, () => sessions),
      env: checkout.env,
    });
    const setting = { cfg, brief, pull: pull.number, continues };
    run.checkStop();
    const summary = await written(
      run,
      sessions,
      "development",
      sessionTask(run, setting, "development"),
    );
    run.checkStop();
    const hardened = await written(
      run,
      sessions,
      "hardening",
      sessionTask(run, setting, "hardening"),
    );
    run.checkStop();
    const head = published(checkout.push());
    run.github.change(["pr", "ready", String(pull.number), "-R", repo]);
    run.comment(
      `Implement finished PR #${pull.number} at ${head} and marked it ready for review.\n\n${summary}\n\n**Hardening:** ${hardened}`,
      "result",
      { pr: pull.number, head },
    );
  } finally {
    sessions?.close();
    try {
      await checkout.close();
    } catch (error: unknown) {
      process.stderr.write(
        `task app ${TASK}: the checkout ${checkout.dirs.root} is kept: ${String(error)}\n`,
      );
    }
  }
}

await main({ id: TASK, work });
