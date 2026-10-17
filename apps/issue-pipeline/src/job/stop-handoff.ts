// What a stage job saves for a writer session it stopped at the hard context
// limit (context-watch.ts; wrap-up-at-175k, Axlog, 2026-10-17). On every
// stop, the job commits the work the session left uncommitted as one WIP
// commit (kill-saves-writer-work), so the job's exit push keeps it, unless the
// checkout is off its branch, mid rebase, merge, cherry-pick or revert, or
// holds unmerged paths, or the commit hooks refuse it; work left uncommitted
// is what the job's exit lists in `lostChanges`. Then it updates the handoff,
// never dropping text already in it (stop-handoff-text.ts):
// - a handoff the session wrote is kept, with a note on its uncommitted work,
//   when there was any: the WIP commit, or why the job made none;
// - an earlier round's handoff the session left unchanged is kept, followed
//   by the job's section on the stopped session;
// - with no handoff before or after, the job writes one: the session's
//   commits, its uncommitted work and the start of its last assistant text.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { run } from "../process.ts";
import type { ContextStop } from "./context-watch.ts";
import type { CheckoutView, WipResult } from "./stop-handoff-text.ts";
import { stopHandoffText } from "./stop-handoff-text.ts";

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

// What the job did for a stopped session: whether it wrote to the handoff
// file (false when it left the file as the session did), and its WIP
// commit's sha, null when it made none.
interface StoppedWork {
  wroteHandoff: boolean;
  wipCommit: string | null;
}

// A stopped writer session, where it worked.
type StoppedSession = StoppedEnd & WriterPlace;

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

// What git shows of `session`'s checkout.
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

// Saves what stopped `session` left: commits its uncommitted work as a WIP
// commit where that is safe, from what git showed before it, then updates
// the handoff without dropping any text already in it.
function saveWork(session: StoppedSession): StoppedWork {
  const { handoffFile, start } = session;
  const view = checkoutView(session);
  let wip: WipResult | null = null;
  if (view.status !== null && view.status !== "") {
    wip = commitWip(session);
  }
  const text = stopHandoffText({
    key: session.key,
    context: session.stop.context,
    lastText: session.lastText,
    startHandoff: start.handoff,
    current: readText(handoffFile),
    view,
    wip,
  });
  if (text !== null) {
    fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
    fs.writeFileSync(handoffFile, text);
  }
  let wipCommit: string | null = null;
  if (wip?.kind === "committed") {
    wipCommit = wip.sha;
  }
  return { wroteHandoff: text !== null, wipCommit };
}

// saveWork for the session at `place` that ended as `end`; a failure is
// reported on stderr and counts as no handoff written and no WIP commit.
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
