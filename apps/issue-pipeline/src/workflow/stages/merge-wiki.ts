// The merge stage's wiki steps, before the code merges: rebase the issue's
// wiki commits onto the wiki's latest version (wiki-sync), let the conflict
// resolver settle a conflict, and check the rebased pages (wiki-check). A
// failed check stops the issue with `agent:stopped-wiki-check`, so a wiki
// that can't be published never follows merged code.

import { noteEvent } from "../event-log.ts";
import { isRecord, syncReplyOf } from "./checks-reply.ts";
import { opFailedStep } from "./network.ts";
import { textOrNull } from "./replies.ts";
import { codedStopStep, launchStep, onlyReply } from "./step.ts";
import { wikiConflicted } from "./sync-conflict.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// The wiki's branch when a reply doesn't name it.
const WIKI_BRANCH = "master";

// How the stage carries on once the wiki passed its check.
type Proceed = (
  state: StageState,
  ctx: StageContext,
  comments: readonly StageComment[],
) => Step;

// Whether the issue has a wiki checkout.
function hasWiki(state: StageState): boolean {
  const { wiki } = state.paths;
  return wiki !== null && wiki !== "";
}

// Asks ops to rebase the issue's wiki commits onto the wiki's latest version.
function syncWiki(state: StageState): Step {
  const payload = { number: state.n };
  return launchStep({ ...state, phase: "wiki-synced", carry: null }, [
    { kind: "op", name: "wiki-sync", op: "wiki-sync", payload },
  ]);
}

// Asks ops to check the issue's wiki pages, after posting `comments`.
function checkWiki(state: StageState, comments: readonly StageComment[]): Step {
  const payload = { number: state.n };
  const checking = { ...state, phase: "wiki-checked", carry: null };
  return launchStep(
    checking,
    [{ kind: "op", name: "wiki-check", op: "wiki-check", payload }],
    comments,
  );
}

// The wiki's branch a conflict reply names.
function branchOf(reply: Readonly<Record<string, unknown>>): string {
  const { branch } = reply;
  return textOrNull(branch) ?? WIKI_BRANCH;
}

// A clean rebase goes on to the wiki check; a conflict goes to the resolver.
function wikiSynced(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const raw = onlyReply(results);
  const reply = syncReplyOf(raw);
  if (reply.kind === "failed") {
    const reason = "could not rebase the wiki changes";
    const failed = { op: "wiki-sync", reason, error: reply.error };
    return opFailedStep(state, failed, ctx.now());
  }
  if (reply.kind === "conflict") {
    const { conflicts: files, baseSha } = reply;
    const branch = branchOf(raw);
    return wikiConflicted(state, ctx, { files, baseSha, branch });
  }
  if (!reply.changed) {
    return checkWiki(state, []);
  }
  const st = { ...state.st };
  noteEvent(
    st,
    "rebased the wiki changes onto the wiki's latest version",
    ctx.now(),
  );
  return checkWiki({ ...state, st }, []);
}

// The failed checks of a wiki-check reply, one line each.
function failuresOf(checks: unknown): string {
  if (!Array.isArray(checks)) {
    return "";
  }
  return checks
    .filter(isRecord)
    .map(({ detail }) => `- ${String(detail)}`)
    .join("\n");
}

// Pages that pass the check go on through `proceed`; others stop the issue.
function wikiChecked(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  proceed: Proceed,
): Step {
  const { ok, error, pass, checks } = onlyReply(results);
  if (ok !== true) {
    const reason = "the wiki check could not run";
    const failed = { op: "wiki-check", reason, error: textOrNull(error) };
    return opFailedStep(state, failed, ctx.now());
  }
  if (pass === true) {
    return proceed(state, ctx, []);
  }
  return codedStopStep(state, {
    reason: "the wiki changes failed the wiki check",
    detail: failuresOf(checks),
    code: "wiki-check",
  });
}

export { branchOf, checkWiki, hasWiki, syncWiki, wikiChecked, wikiSynced };
