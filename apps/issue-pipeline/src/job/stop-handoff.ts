// The handoff a stage job writes for a writer session it stopped at the hard
// context limit (context-watch.ts) that left no handoff file, or left it as
// it found it (wrap-up-at-175k, Axlog, 2026-10-17): a header saying the
// session was stopped before it wrote its summary, the session's commits, its
// uncommitted work and the start of its last assistant text. Before writing
// it, the job commits that uncommitted work as one WIP commit
// (kill-saves-writer-work), so the job's exit push keeps it, unless the
// checkout is off its branch, mid rebase, merge, cherry-pick or revert, or
// holds unmerged paths, or the commit hooks refuse it; the handoff says which.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { run } from "../process.ts";
import type { ContextStop } from "./context-watch.ts";

// How much of the session's last assistant text the handoff keeps.
const LAST_TEXT_CHARS = 2000;
// The longest one git command, a commit's hooks included, may take.
const COMMIT_TIMEOUT_MS = 120_000;
// What git keeps under .git while an operation a commit would break is in
// progress.
const IN_PROGRESS: readonly string[] = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];
const BACKTICKS = /`+/gu;
const MIN_FENCE = 3;

// What the job notes as a writer session starts: its checkout's HEAD, null
// when it has none, and the handoff file's text, null when there is none.
interface HandoffStart {
  head: string | null;
  handoff: string | null;
}

// Where a writer session works, and where its handoff goes.
interface WriterPlace {
  cwd: string;
  handoffFile: string;
}

// How a writer session the job stopped at the hard limit ended: its launch
// key, its stop, its last assistant text (null when it gave none) and what
// the job noted as it started.
interface StoppedEnd {
  key: string;
  stop: ContextStop;
  lastText: string | null;
  start: HandoffStart;
}

// What the job did for a stopped session: whether it wrote the handoff file
// (false when the session wrote its own), and its WIP commit's sha, null when
// it made none.
interface StoppedWork {
  wroteHandoff: boolean;
  wipCommit: string | null;
}

// A stopped writer session, where it worked.
type StoppedSession = StoppedEnd & WriterPlace;

// The WIP commit's sha, or why the job made none.
type WipResult =
  | { kind: "committed"; sha: string }
  | { kind: "left"; why: string };

// git's trimmed stdout in `cwd`, run with `env` added to the job's
// environment, or null when it fails.
function gitOut(
  cwd: string,
  args: readonly string[],
  env: ReadonlyMap<string, string> = new Map(),
): string | null {
  const options = { allowFail: true, cwd, timeoutMs: COMMIT_TIMEOUT_MS, env };
  const result = run("git", ["-C", cwd, ...args], options);
  if (result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// What the job notes as a writer session in `cwd` starts.
function handoffStartOf(cwd: string, handoffFile: string): HandoffStart {
  const head = gitOut(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return { head, handoff: readText(handoffFile) };
}

// Why the job can't safely commit in `cwd`, or null when it can.
function unsafeToCommit(cwd: string): string | null {
  if (gitOut(cwd, ["symbolic-ref", "--quiet", "HEAD"]) === null) {
    return "the checkout is not on a branch";
  }
  for (const name of IN_PROGRESS) {
    const at = gitOut(cwd, ["rev-parse", "--git-path", name]);
    if (at !== null && fs.existsSync(path.resolve(cwd, at))) {
      return `a git operation is in progress (${name})`;
    }
  }
  const unmerged = gitOut(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged !== null && unmerged !== "") {
    return "the checkout has unmerged paths";
  }
  return null;
}

// Commits everything `session` left uncommitted as one WIP commit, through
// the commit hooks; a refused commit is unstaged again.
function commitWip(session: StoppedSession): WipResult {
  const { cwd, key, stop } = session;
  const unsafe = unsafeToCommit(cwd);
  if (unsafe !== null) {
    return { kind: "left", why: unsafe };
  }
  if (gitOut(cwd, ["add", "--all"]) === null) {
    gitOut(cwd, ["reset", "--quiet"]);
    return { kind: "left", why: "git add failed" };
  }
  const message = `WIP: work ${key} left uncommitted when the job stopped it at the hard context limit (${stop.context})\n\nPipeline-Agent: stage job`;
  const commit = ["commit", "--quiet", "-m", message];
  // The checkout's pre-commit hook passes only commits that say so (#303).
  const env = new Map([["ISSUE_PIPELINE_COMMIT", "1"]]);
  if (gitOut(cwd, commit, env) === null) {
    gitOut(cwd, ["reset", "--quiet"]);
    return { kind: "left", why: "git commit failed or its hooks refused it" };
  }
  const sha = gitOut(cwd, ["rev-parse", "--short", "HEAD"]) ?? "HEAD";
  return { kind: "committed", sha };
}

// `text` in a code fence longer than any run of backticks in it.
function fenced(text: string): string {
  const runs = text.match(BACKTICKS) ?? [];
  const longest = Math.max(0, ...runs.map((found) => found.length));
  const fence = "`".repeat(Math.max(MIN_FENCE, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

// `text` as a fenced block, or `none` when it is empty.
function blockOr(text: string | null, none: string): string {
  if (text === null || text === "") {
    return none;
  }
  return fenced(text);
}

// The start of the session's last assistant text, cut to LAST_TEXT_CHARS.
function lastTextOf(text: string | null): string | null {
  if (text === null || text.length <= LAST_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, LAST_TEXT_CHARS)}\n[… cut at ${LAST_TEXT_CHARS} characters]`;
}

function wipLine(wip: WipResult | null): string {
  if (wip === null) {
    return "";
  }
  if (wip.kind === "committed") {
    return `\n\nThe job committed this work as WIP commit ${wip.sha}, which may not build.`;
  }
  return `\n\nThe job left this work uncommitted (${wip.why}); it is lost when the job's checkout is removed.`;
}

// What git showed of a stopped session's checkout before any WIP commit:
// its commits since it started, and its uncommitted work.
interface CheckoutView {
  log: string | null;
  status: string | null;
  diffStat: string | null;
}

function checkoutView(session: StoppedSession): CheckoutView {
  const { cwd, start } = session;
  let log: string | null = "(the session's start commit is unknown)";
  if (start.head !== null) {
    log = gitOut(cwd, ["log", "--oneline", `${start.head}..HEAD`]);
  }
  const status = gitOut(cwd, ["status", "--short"]);
  const diffStat = gitOut(cwd, ["diff", "--stat", "HEAD"]);
  return { log, status, diffStat };
}

// The handoff for `session`, from what git showed (`view`) and the WIP
// commit (`wip`, null when there was nothing to commit).
function handoffText(
  session: StoppedSession,
  view: CheckoutView,
  wip: WipResult | null,
): string {
  const { key, stop } = session;
  return [
    "# Handoff: the session was stopped before it wrote its summary",
    "",
    `The job stopped writer session ${key} at ${stop.context} tokens of context, past the hard context limit, before it wrote its own summary. The job wrote this handoff from the checkout. Check the branch before you trust it.`,
    "",
    "## The session's commits (`git log --oneline` since its start)",
    "",
    blockOr(view.log, "None."),
    "",
    "## Uncommitted work when it stopped",
    "",
    "`git status --short`:",
    "",
    blockOr(view.status, "Nothing uncommitted."),
    "",
    "`git diff --stat HEAD`:",
    "",
    `${blockOr(view.diffStat, "No changes to tracked files.")}${wipLine(wip)}`,
    "",
    "## The session's last assistant text",
    "",
    blockOr(lastTextOf(session.lastText), "None."),
    "",
  ].join("\n");
}

// Saves what stopped `session` left: when it wrote no handoff file of its
// own, commits its uncommitted work as a WIP commit where that is safe and
// writes the handoff for it.
function saveWork(session: StoppedSession): StoppedWork {
  const { handoffFile, start } = session;
  const current = readText(handoffFile);
  if (current !== null && current !== start.handoff) {
    return { wroteHandoff: false, wipCommit: null };
  }
  const view = checkoutView(session);
  let wip: WipResult | null = null;
  if (view.status !== null && view.status !== "") {
    wip = commitWip(session);
  }
  const text = handoffText(session, view, wip);
  fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
  fs.writeFileSync(handoffFile, text);
  let wipCommit: string | null = null;
  if (wip?.kind === "committed") {
    wipCommit = wip.sha;
  }
  return { wroteHandoff: true, wipCommit };
}

// saveWork for the session at `place` that ended as `end`; a failure is
// reported on stderr, changes nothing else, and counts as no handoff written.
function saveStoppedWork(place: WriterPlace, end: StoppedEnd): StoppedWork {
  const session = { ...end, cwd: place.cwd, handoffFile: place.handoffFile };
  try {
    return saveWork(session);
  } catch (error: unknown) {
    let reason = String(error);
    if (error instanceof Error) {
      reason = error.message;
    }
    process.stderr.write(
      `job: ${session.key}: cannot save its work: ${reason}\n`,
    );
    return { wroteHandoff: false, wipCommit: null };
  }
}

export type { HandoffStart, StoppedEnd, StoppedWork, WriterPlace };
export { handoffStartOf, saveStoppedWork };
