// The issue's pull request: start-pr opens it as a draft before any code is
// written, or, given a body, sets the body of the one it finds; open-pr fills
// it in and marks it ready (reopening a closed one), close-pr closes the draft
// of a change that lives only in the wiki, and push pushes the branch. How a PR links to its issue lives here.

import { z } from "zod";
import type { BranchChanges } from "../checkouts.ts";
import { ensureWorktree, push } from "../checkouts.ts";
import type { Author } from "../comments.ts";
import { AUTHOR, signed } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, remoteHead } from "../git-state.ts";
import { gh, ghJson } from "../github.ts";
import { LABELS, setLabels } from "../labels.ts";
import { OpsError, run } from "../process.ts";
import { openPrFor } from "./prs.ts";

interface PrReply {
  pr: number;
  headSha: string;
}

interface OpenReply extends PrReply, BranchChanges {}

interface PushReply extends BranchChanges {
  headSha: string;
}

interface CloseReply {
  pr: number;
  closed: true;
}

type Op = (
  cfg: Config,
  request: unknown,
) => PrReply | OpenReply | PushReply | CloseReply;

const DRAFT_TEXT =
  "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description and marks it ready for review once the change is pushed.";
const IMPLEMENTER: Author = { role: "implementer" };
const COORDINATOR: Author = { role: "coordinator" };

const START_REQUEST = z.looseObject({
  number: z.number().int(),
  plan: z.string().nullish(),
  body: z.string().nullish(),
});
const OPEN_REQUEST = z.looseObject({
  number: z.number().int(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  by: AUTHOR.nullish(),
  reopen: z.number().int().nullish(),
});
const CLOSE_REQUEST = z.looseObject({
  number: z.number().int(),
  pr: z.number().int(),
});
const PUSH_REQUEST = z.looseObject({ number: z.number().int() });
const ISSUE = z.looseObject({ title: z.string() });

// The value `schema` parses from `value`, or an OpsError naming `what`.
function parsed<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new OpsError(`bad ${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

// `text`, or `fallback` when it is missing or empty.
function textOr(text: string | null | undefined, fallback: string): string {
  if (text === undefined || text === null || text === "") {
    return fallback;
  }
  return text;
}

// PRs link to their issue twice: the body starts with "Closes #N", which links the
// PR under the issue's Development section and closes it on merge, and the title
// ends with "(#N)", so the squash commit on the base branch names the issue too.
function titleFor(n: number, title: string): string {
  if (new RegExp(`#${n}\\b`, "u").test(title)) {
    return title;
  }
  return `${title} (#${n})`;
}

function closesBody(n: number, text: string): string {
  const links = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #${n}\\b`,
    "iu",
  );
  if (links.test(text)) {
    return text;
  }
  return `Closes #${n}\n\n${text}`;
}

// Opens a PR for the issue's branch and returns its number.
function createPr(
  cfg: Config,
  n: number,
  flags: readonly string[],
  text: { title: string; body: string },
): number {
  const args = ["pr", "create", "-R", cfg.repo, ...flags];
  const url = gh(cfg, [
    ...args,
    "--base",
    cfg.baseBranch,
    "--head",
    paths.branch(n),
    "--title",
    text.title,
    "--body",
    text.body,
  ]).stdout.trim();
  return Number(url.split("/").pop());
}

function planDetails(plan: string | null | undefined): string {
  if (plan === undefined || plan === null || plan === "") {
    return "";
  }
  return `\n<details><summary>Plan</summary>\n\n${plan}\n\n</details>`;
}

// The branch's head on origin. A new branch starts with an empty commit, since
// GitHub refuses a PR with no commits; the squash merge drops it.
function startBranch(cfg: Config, n: number): string {
  const wt = ensureWorktree(cfg, n);
  const remote = remoteHead(cfg, n);
  if (remote !== null) {
    return remote;
  }
  assertClean(wt);
  const message = `Start work on #${n}\n\nPipeline-Agent: coordinator`;
  // A job checkout's pre-commit hook passes only commits that say so.
  const env = new Map([["ISSUE_PIPELINE_COMMIT", "1"]]);
  run("git", ["-C", wt, "commit", "--allow-empty", "-m", message], { env });
  return push(cfg, n, "start-pr", { allowEmpty: true }).headSha;
}

// The PR body a start-pr request's `body` gives issue `n`, signed by the
// coordinator, or undefined when it gives none (missing or empty).
function givenBody(
  n: number,
  body: string | null | undefined,
): string | undefined {
  if (body === undefined || body === null || body === "") {
    return undefined;
  }
  return signed(COORDINATOR, closesBody(n, body));
}

// Opens the issue's PR as a draft before any code is written, or finds the
// branch's open PR, and labels it working. Given a body, the draft opens with
// it, or the found PR's body becomes it, staying a draft or ready as it was.
// open-pr later fills in the PR and marks it ready.
function startPr(cfg: Config, request: unknown): PrReply {
  const req = parsed(START_REQUEST, "start-pr request", request);
  const n = req.number;
  const reply = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}`]);
  const issue = parsed(ISSUE, "gh issue reply", reply);
  const headSha = startBranch(cfg, n);
  const given = givenBody(n, req.body);
  let pr = openPrFor(cfg, n);
  if (pr === undefined) {
    const text = [DRAFT_TEXT, planDetails(req.plan)].join("\n");
    pr = createPr(cfg, n, ["--draft"], {
      title: titleFor(n, issue.title),
      body: given ?? signed(COORDINATOR, closesBody(n, text)),
    });
  } else if (given !== undefined) {
    gh(cfg, ["pr", "edit", String(pr), "-R", cfg.repo, "--body", given]);
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha };
}

// The issue's open PR, else `reopen` reopened, else none (undefined).
function existingPr(
  cfg: Config,
  n: number,
  reopen: number | null | undefined,
): number | undefined {
  const open = openPrFor(cfg, n);
  if (open !== undefined || reopen === undefined || reopen === null) {
    return open;
  }
  const args = ["pr", "reopen", String(reopen), "-R", cfg.repo];
  if (gh(cfg, args, { allowFail: true }).code === 0) {
    return reopen;
  }
  return undefined;
}

// Pushes the branch, then fills in the issue's PR and marks it ready when the
// branch changes files. A change that lives only in the wiki leaves the draft
// as it is.
function openPr(cfg: Config, request: unknown): OpenReply {
  const req = parsed(OPEN_REQUEST, "open-pr request", request);
  const n = req.number;
  const pushed = push(cfg, n, "open-pr");
  const title = titleFor(n, textOr(req.title, `Fix #${n}`));
  const body = signed(
    req.by ?? IMPLEMENTER,
    closesBody(n, textOr(req.body, "")),
  );
  if (!pushed.codeChanged) {
    const draft =
      openPrFor(cfg, n) ?? createPr(cfg, n, ["--draft"], { title, body });
    return { pr: draft, ...pushed };
  }
  let pr = existingPr(cfg, n, req.reopen);
  if (pr === undefined) {
    pr = createPr(cfg, n, [], { title, body });
  } else {
    // The draft from start-pr, or a reopened PR: fill it in and mark it ready.
    const number = String(pr);
    const edit = ["--title", title, "--body", body];
    gh(cfg, ["pr", "edit", number, "-R", cfg.repo, ...edit]);
    gh(cfg, ["pr", "ready", number, "-R", cfg.repo], { allowFail: true });
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, ...pushed };
}

// gh's answer to a PR's state ("OPEN", "CLOSED" or "MERGED").
const PR_STATE = z.looseObject({ state: z.string() });

function isOpen(cfg: Config, pr: number): boolean {
  const args = ["pr", "view", String(pr), "-R", cfg.repo, "--json", "state"];
  return PR_STATE.safeParse(ghJson(cfg, args)).data?.state === "OPEN";
}

// Closes the draft PR of a change that lives only in the wiki, saying where
// the change is. A PR that isn't open is left as it is, so a second close
// posts nothing.
function closePr(cfg: Config, request: unknown): CloseReply {
  const req = parsed(CLOSE_REQUEST, "close-pr request", request);
  if (!isOpen(cfg, req.pr)) {
    return { pr: req.pr, closed: true };
  }
  const branch = paths.branch(req.number);
  const text = `This change lives only in the wiki, on the wiki branch \`${branch}\`, so this PR has no code to merge and is closed. The pipeline reopens it if a later fix changes code.`;
  const comment = signed(COORDINATOR, text);
  gh(cfg, [
    "pr",
    "close",
    String(req.pr),
    "-R",
    cfg.repo,
    "--comment",
    comment,
  ]);
  return { pr: req.pr, closed: true };
}

function pushOp(cfg: Config, request: unknown): PushReply {
  const { number } = parsed(PUSH_REQUEST, "push request", request);
  return push(cfg, number, "push");
}

// The push a writer's stage job makes as it exits, of commits its checkout
// holds past the last state save (src/job/exit-push.ts). It is recorded as
// "exit-push", which the next claim may adopt (src/start-state.ts).
function exitPushOp(cfg: Config, request: unknown): PushReply {
  const { number } = parsed(PUSH_REQUEST, "exit-push request", request);
  return push(cfg, number, "exit-push");
}

const prOps: Readonly<Record<string, Op>> = {
  "start-pr": startPr,
  "open-pr": openPr,
  "close-pr": closePr,
  push: pushOp,
  "exit-push": exitPushOp,
};

export { prOps };
