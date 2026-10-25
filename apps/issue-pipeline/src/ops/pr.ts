// The issue's pull request: start-pr opens it as a draft before any code is
// written, or, given a body, sets the body of the one it finds; open-pr fills
// it in, still a draft (reopening a closed one); ready-pr marks it ready once
// the Reviewer approved its exact revision. How a PR links to its issue
// lives here. Once the saved state records the code landed, neither start-pr nor
// open-pr pushes code.

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
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import { recoverDraft, saveDraftAuthority } from "./pr-state.ts";
import { openPrFor } from "./prs.ts";
import { refuseOnceLanded } from "./push.ts";
import type { ReadyReply } from "./ready-pr.ts";
import { readyPr } from "./ready-pr.ts";

interface PrReply {
  pr: number;
  headSha: string;
}

interface OpenReply extends PrReply, BranchChanges {}

type Op = (cfg: Config, request: unknown) => PrReply | OpenReply | ReadyReply;

const DRAFT_TEXT =
  "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description once the change is pushed, and marks it ready for review once the Reviewer approves it.";
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
  // A lost reply is reconciled by finding the PR the branch names (openPrFor).
  const url = gh(
    cfg,
    "dev",
    [
      ...args,
      "--base",
      cfg.baseBranch,
      "--head",
      paths.branch(cfg, n),
      "--title",
      text.title,
      "--body",
      text.body,
    ],
    { reconciles: true },
  ).stdout.trim();
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
// open-pr later fills in the PR, and ready-pr marks it ready.
function startPr(cfg: Config, request: unknown): PrReply {
  const req = parsed(START_REQUEST, "start-pr request", request);
  const n = req.number;
  refuseOnceLanded(cfg, n, "start-pr");
  const reply = ghJson(cfg, "landing", [
    "api",
    `repos/${cfg.repo}/issues/${n}`,
  ]);
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
    gh(cfg, "dev", ["pr", "edit", String(pr), "-R", cfg.repo, "--body", given]);
  }
  saveDraftAuthority(cfg, n, pr, headSha);
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha };
}

// Pushes the branch, then fills in the issue's PR when the branch changes
// files, leaving it a draft: a new PR opens as one, and a found or reopened
// one keeps its draft status.
// the draft as it is.
function openPr(cfg: Config, request: unknown): OpenReply {
  const req = parsed(OPEN_REQUEST, "open-pr request", request);
  const n = req.number;
  if (req.reopen !== null && req.reopen !== undefined) {
    recoverDraft(cfg, n, req.reopen);
  }
  refuseOnceLanded(cfg, n, "open-pr");
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
  let pr = openPrFor(cfg, n);
  if (pr === undefined) {
    pr = createPr(cfg, n, ["--draft"], { title, body });
  } else {
    // The draft from start-pr, or a reopened PR: fill it in.
    const edit = ["--title", title, "--body", body];
    gh(cfg, "dev", ["pr", "edit", String(pr), "-R", cfg.repo, ...edit]);
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, ...pushed };
}

const prOps: Readonly<Record<string, Op>> = {
  "start-pr": startPr,
  "open-pr": openPr,
  "ready-pr": readyPr,
};

export { prOps };
