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
import type {
  DomainOutcome,
  ExecutionContext,
  TaskDefinition,
} from "@ecosystem/task-framework";
import type {
  SessionPhase,
  SessionResult,
} from "@ecosystem/task-runtime/domain";
import type { IssueGitHub } from "@ecosystem/task-runtime/issue/issue-github";
import type {
  PullRequest,
  Recovery,
} from "@ecosystem/task-runtime/issue/recovery";
import type { PushReply } from "@ecosystem/task-runtime/job/control-protocol";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { WRITER_REPLY } from "./reply.ts";

const implementInputs = z.strictObject({
  issue: z.strictObject({
    repo: z.string().min(1),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  developmentAccount: z.string().min(1),
  baseBranch: z.string().min(1),
  testCommand: z.string(),
  model: z.string().min(1),
});
type ImplementInputs = z.infer<typeof implementInputs>;
type Pushed =
  | { kind: "pushed" | "current"; head: string }
  | { kind: "diverged"; head: string; recovery: string };
interface ImplementCheckout {
  ahead: () => number;
  start: (issue: number) => void;
  push: () => Pushed;
  close: () => Promise<void>;
}
interface WriterSession {
  profile: "developer";
  page: string;
  phase: SessionPhase | null;
  task: string;
  schema: z.ZodType;
  commits: boolean;
}
interface ImplementSessions {
  run: (session: WriterSession) => Promise<SessionResult>;
  abort: () => void;
  close: () => void;
}
interface ImplementCapabilities {
  github: Pick<IssueGitHub, "change" | "stopped">;
  recovery: Pick<Recovery, "pullRequest" | "issue" | "branch">;
  openCheckout: () => ImplementCheckout;
  writeBrief: (pull: PullRequest) => string;
  openSessions: (push: () => PushReply) => Promise<ImplementSessions>;
  checkStop: () => void;
  report: (body: string, kind: string, payload: object) => void;
  retained: (error: unknown) => void;
}
interface TaskRun extends ImplementInputs, ImplementCapabilities {}

const TASK = "implement";
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
function publishBranch(checkout: ImplementCheckout, issue: number): string {
  if (checkout.ahead() === 0) {
    checkout.start(issue);
  }
  return published(checkout.push());
}

// The issue's open PR, as a draft: `found`, or one opened now.
function draftPull(
  run: TaskRun,
  cfg: ImplementInputs,
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
  setting: {
    cfg: ImplementInputs;
    brief: string;
    pull: number;
    continues: boolean;
  },
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
    `commands.test: ${JSON.stringify(cfg.testCommand)}`,
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
  sessions: ImplementSessions,
  kind: "development" | "hardening",
  task: string,
): Promise<z.infer<typeof WRITER_REPLY>> {
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
  return reply;
}

// What a session's `pipeline_commit` hears of its push. While
// `agents:stop` is on the issue nothing is pushed and the sessions are
// asked to abort; the commits stay in the checkout.
function pusher(
  run: TaskRun,
  checkout: ImplementCheckout,
  sessions: () => ImplementSessions | null,
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

async function work(run: TaskRun): Promise<DomainOutcome<string>> {
  const cfg = run;
  if (!same(run.account, cfg.developmentAccount)) {
    throw new OpsError(
      `Implement pushes code as the repository's development account @${cfg.developmentAccount}, and this buddy is @${run.account}`,
    );
  }
  const { number, repo } = run.issue;
  const prior = run.recovery.pullRequest();
  if (prior?.state === "MERGED") {
    return { status: "no-change", result: "Issue PR already merged" };
  }
  if (prior !== null && prior.state !== "OPEN") {
    return {
      status: "needs-input",
      result: "Reopen the closed issue PR before continuing",
    };
  }
  const found = reusablePull(run);
  const continues = found !== null || run.recovery.branch() !== null;
  const checkout = run.openCheckout();
  let sessions: ImplementSessions | null = null;
  try {
    run.checkStop();
    publishBranch(checkout, number);
    const pull = draftPull(run, cfg, found);
    const brief = run.writeBrief(pull);
    sessions = await run.openSessions(pusher(run, checkout, () => sessions));
    const setting = { cfg, brief, pull: pull.number, continues };
    run.checkStop();
    const development = await written(
      run,
      sessions,
      "development",
      sessionTask(run, setting, "development"),
    );
    if (development.outcome === "cannot") {
      return { status: "needs-input", result: development.reason };
    }
    const { summary } = development;
    run.checkStop();
    const hardening = await written(
      run,
      sessions,
      "hardening",
      sessionTask(run, setting, "hardening"),
    );
    if (hardening.outcome === "cannot") {
      return { status: "needs-input", result: hardening.reason };
    }
    const hardened = hardening.summary;
    run.checkStop();
    const head = published(checkout.push());
    const current = run.recovery.pullRequest();
    if (current?.state !== "OPEN" || current.headSha !== head) {
      throw new OpsError("PR head moved before marking ready");
    }
    run.github.change(["pr", "ready", String(pull.number), "-R", repo]);
    run.report(
      `Implement finished PR #${pull.number} at ${head} and marked it ready for review.\n\n${summary}\n\n**Hardening:** ${hardened}`,
      "result",
      { pr: pull.number, head },
    );
    return { status: "completed", result: summary };
  } finally {
    sessions?.close();
    try {
      await checkout.close();
    } catch (error: unknown) {
      run.retained(error);
    }
  }
}

const implement: TaskDefinition<
  ImplementInputs,
  ImplementCapabilities,
  string
> = {
  id: TASK,
  inputs: implementInputs,
  run: async (
    inputs: ImplementInputs,
    capabilities: ImplementCapabilities,
    context: ExecutionContext,
  ): Promise<DomainOutcome<string>> => {
    function checkStop(): void {
      context.checkCancelled();
      capabilities.checkStop();
    }
    return await work({ ...inputs, ...capabilities, checkStop });
  },
};

export type {
  ImplementCapabilities,
  ImplementCheckout,
  ImplementInputs,
  ImplementSessions,
  WriterSession,
};
export { implement, implementInputs };
