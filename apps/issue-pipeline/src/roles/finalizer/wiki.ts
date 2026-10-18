// The finalizer's wiki steps before the code merges, for an issue with a
// wiki checkout: rebase the issue's wiki commits onto the wiki's latest
// version (wiki-sync), handing a conflict to the conflict resolver
// (resolver.ts) while attempts remain, and check the rebased pages
// (wiki-check). A failed check stops the issue with `wiki-check`, so a wiki
// that can't be published never follows merged code. Pure.

import type { SyncReply } from "../../workflow/stages/checks-reply.ts";
import { isRecord, syncReplyOf } from "../../workflow/stages/checks-reply.ts";
import { maxConflictFixes } from "../../workflow/stages/conflict-resolver.ts";
import type { Effect } from "../machine.ts";
import type { LinearStep } from "../walk.ts";
import { noted, opFailed, stopped, stoppedFor } from "./ends.ts";
import type { FinalizerData, WikiConflict } from "./locate.ts";

// The wiki's branch when a conflict reply doesn't name it.
const WIKI_BRANCH = "master";

// Whether the issue has a wiki checkout.
function hasWiki(data: FinalizerData): boolean {
  const { wiki } = data.item.paths;
  return wiki !== null && wiki !== "";
}

// Whether a wiki step is passed over: the run has ended, or there is no wiki.
function noWikiStep(data: FinalizerData): boolean {
  return data.end !== null || !hasWiki(data);
}

function fileListOf(files: readonly string[]): string {
  return `Conflicting files:\n${files.join("\n")}`;
}

// The ops request for `op` on the issue.
function wikiOp(op: string): (data: FinalizerData) => Effect {
  return (data: FinalizerData): Effect => ({
    kind: "op",
    op,
    payload: { number: data.issue },
  });
}

// The rebase stopped on conflicts: the resolver runs while the issue has
// conflict attempts left, counting this one, and the issue stops once they
// have run out.
function conflicted(
  data: FinalizerData,
  conflict: WikiConflict,
): FinalizerData {
  const max = maxConflictFixes(data.settings);
  const { files, branch } = conflict;
  if (data.conflictFixes >= max) {
    return stoppedFor(
      data,
      `rebasing the wiki onto ${branch} conflicts again after ${max} resolutions`,
      fileListOf(files),
    );
  }
  return {
    ...data,
    conflictFixes: data.conflictFixes + 1,
    conflict,
    resolution: { kind: "none" },
  };
}

function branchOf(reply: Readonly<Record<string, unknown>>): string {
  const { branch } = reply;
  if (typeof branch === "string") {
    return branch;
  }
  return WIKI_BRANCH;
}

// A clean rebase goes on to the wiki check; a conflict to the resolver.
function synced(data: FinalizerData, raw: unknown): FinalizerData {
  let reply: SyncReply = { kind: "failed", error: null };
  let branch = WIKI_BRANCH;
  if (isRecord(raw)) {
    reply = syncReplyOf(raw);
    branch = branchOf(raw);
  }
  switch (reply.kind) {
    case "failed":
      return syncFailed(
        data,
        reply.error ?? "the wiki-sync reply is unreadable",
      );
    case "conflict": {
      const { conflicts: files, baseSha } = reply;
      return conflicted(data, { files, baseSha, branch });
    }
    case "clean":
      if (!reply.changed) {
        return data;
      }
      return noted(
        data,
        "rebased the wiki changes onto the wiki's latest version",
      );
    default: {
      const unhandled: never = reply;
      return unhandled;
    }
  }
}

function syncFailed(data: FinalizerData, error: string): FinalizerData {
  const reason = "could not rebase the wiki changes";
  return opFailed(data, "wiki-sync", reason, error);
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

// Pages that pass the check go on to the merge; others stop the issue.
function checked(data: FinalizerData, reply: unknown): FinalizerData {
  let pass: unknown = false;
  let checks: unknown = [];
  if (isRecord(reply)) {
    ({ pass, checks } = reply);
  }
  if (pass === true) {
    return data;
  }
  return stopped(data, {
    code: "wiki-check",
    reason: "the wiki changes failed the wiki check",
    detail: failuresOf(checks),
  });
}

const wikiSyncStep: LinearStep<FinalizerData> = {
  name: "wiki-sync",
  kind: "script",
  skip: noWikiStep,
  effect: wikiOp("wiki-sync"),
  apply: synced,
  recover: syncFailed,
};

const wikiCheckStep: LinearStep<FinalizerData> = {
  name: "wiki-check",
  kind: "script",
  skip: noWikiStep,
  effect: wikiOp("wiki-check"),
  apply: checked,
  recover: (data: FinalizerData, error: string): FinalizerData =>
    opFailed(data, "wiki-check", "the wiki check could not run", error),
};

export { fileListOf, wikiCheckStep, wikiSyncStep };
