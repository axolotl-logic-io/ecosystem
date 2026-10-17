// The wording of the handoff a stage job leaves for a writer session it
// stopped at the hard context limit (wrap-up-at-175k), from what git showed
// of the session's checkout and the job's WIP commit (kill-saves-writer-work).
// It never drops text already in the handoff file:
// - a handoff the session wrote stays as it is, with a note on the work it
//   left uncommitted appended, when there was any;
// - an earlier round's handoff the session left unchanged, or deleted, stays
//   first, followed by the job's own section on the stopped session;
// - with no handoff before or after, the job writes the whole handoff.
// Every git output and the last text sit in code fences, so they can't break
// the headings.

const BACKTICKS = /`+/gu;
const MIN_FENCE = 3;
// How much of the session's last assistant text the handoff keeps.
const LAST_TEXT_CHARS = 2000;

// What git showed of a stopped session's checkout before any WIP commit:
// its commits since it started, and its uncommitted work.
interface CheckoutView {
  log: string | null;
  status: string | null;
  diffStat: string | null;
}

// The WIP commit's sha, or why the job made none.
type WipResult =
  | { kind: "committed"; sha: string }
  | { kind: "left"; why: string };

// What the handoff is written from: the session's launch key, the context it
// was stopped at, its last assistant text (null when it gave none), the
// handoff file's text as it started and now (null when there was none), what
// git showed (`view`) and the WIP commit (`wip`, null when there was nothing
// to commit).
interface StopHandoffFacts {
  key: string;
  context: number;
  lastText: string | null;
  startHandoff: string | null;
  current: string | null;
  view: CheckoutView;
  wip: WipResult | null;
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

// The session's uncommitted work, and what the job did with it.
function uncommittedLines(view: CheckoutView, wip: WipResult | null): string[] {
  return [
    "`git status --short`:",
    "",
    blockOr(view.status, "Nothing uncommitted."),
    "",
    "`git diff --stat HEAD`:",
    "",
    `${blockOr(view.diffStat, "No changes to tracked files.")}${wipLine(wip)}`,
  ];
}

// The session's commits, uncommitted work and last text, each under a
// heading that starts with `prefix`.
function sessionLines(facts: StopHandoffFacts, prefix: string): string[] {
  return [
    `${prefix} The session's commits (\`git log --oneline\` since its start)`,
    "",
    blockOr(facts.view.log, "None."),
    "",
    `${prefix} Uncommitted work when it stopped`,
    "",
    ...uncommittedLines(facts.view, facts.wip),
    "",
    `${prefix} The session's last assistant text`,
    "",
    blockOr(lastTextOf(facts.lastText), "None."),
    "",
  ];
}

// `earlier`, a blank line, then `section`.
function appended(earlier: string, section: string): string {
  let separator = "\n";
  if (!earlier.endsWith("\n")) {
    separator = "\n\n";
  }
  return `${earlier}${separator}${section}`;
}

// The whole handoff, for a session that left none and found none.
function wholeHandoff(facts: StopHandoffFacts): string {
  return [
    "# Handoff: the session was stopped before it wrote its summary",
    "",
    `The job stopped writer session ${facts.key} at ${facts.context} tokens of context, past the hard context limit, before it wrote its own summary. The job wrote this handoff from the checkout. Check the branch before you trust it.`,
    "",
    ...sessionLines(facts, "##"),
  ].join("\n");
}

// The job's section on the stopped session, below an earlier round's handoff.
function stoppedSection(facts: StopHandoffFacts): string {
  return [
    `## Stopped session ${facts.key} (written by the job)`,
    "",
    `The job stopped this session at ${facts.context} tokens of context, past the hard context limit, while the earlier handoff above was still unchanged. The job wrote this section from the checkout. Check the branch before you trust it.`,
    "",
    ...sessionLines(facts, "###"),
  ].join("\n");
}

// The job's note on the work a session left uncommitted after it wrote its
// own handoff.
function uncommittedNote(facts: StopHandoffFacts, wip: WipResult): string {
  return [
    `## Uncommitted work when the job stopped session ${facts.key} (written by the job)`,
    "",
    `The job stopped this session at ${facts.context} tokens of context, past the hard context limit, after it wrote this handoff.`,
    "",
    ...uncommittedLines(facts.view, wip),
    "",
  ].join("\n");
}

// The handoff file's new text for a stopped session, or null when the file
// stays as the session left it.
function stopHandoffText(facts: StopHandoffFacts): string | null {
  const { current, startHandoff, wip } = facts;
  if (current !== null && current !== startHandoff) {
    if (wip === null) {
      return null;
    }
    return appended(current, uncommittedNote(facts, wip));
  }
  if (startHandoff !== null) {
    return appended(startHandoff, stoppedSection(facts));
  }
  return wholeHandoff(facts);
}

export type { CheckoutView, StopHandoffFacts, WipResult };
export { appended, stopHandoffText };
