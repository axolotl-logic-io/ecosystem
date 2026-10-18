// The finalizer role on the runner's linear mode: today's `merge` stage
// (src/workflow/stages/merge.ts) as steps. The open-findings gate (locate),
// the wiki's rebase and check with the conflict resolver on a conflict, then
// the merge op at the verified head in merge order (or finish-wiki for a
// change that lives only in the wiki), and an end read from the merge's
// reply. The merge op writes the merged issue's state and labels itself, and
// one that finds the PR already merged does only that bookkeeping, so a
// restart after the merge never merges twice. Pure.

import { wikiOnly } from "../../workflow/flows.ts";
import { acceptanceSummary } from "../../workflow/summary.ts";
import type { Effect } from "../machine.ts";
import type { LinearScript, LinearStep } from "../walk.ts";
import { ended, endOf, noted, opFailed, stoppedFor } from "./ends.ts";
import type { FinalizerData } from "./locate.ts";
import { locate, stateOf } from "./locate.ts";
import { mergeReplyOf } from "./merge-reply.ts";
import { finishWikiSyncStep, resolveStep } from "./resolver.ts";
import { wikiCheckStep, wikiSyncStep } from "./wiki.ts";

// The merge, or for a change that lives only in the wiki the finish-wiki op,
// which publishes the wiki and closes the issue as merged. The merge waits
// on the orchestrator's merge queue when it passed one.
function mergeEffect(data: FinalizerData): Effect {
  const { issue: number, st, settings, mergeQueue } = data;
  const state = stateOf(data);
  if (wikiOnly(st.flows)) {
    return { kind: "op", op: "finish-wiki", payload: { number, state } };
  }
  const checks = st.verifySummary ?? "";
  const acceptance = acceptanceSummary(settings.cfg, {
    st,
    rebasedOnly: false,
  });
  const payload = {
    number,
    state,
    expectedSha: st.verifiedSha,
    mergeOrder: true,
    summary: `Checks: ${checks}\n\nAcceptance: ${acceptance}`,
  };
  if (mergeQueue === null) {
    return { kind: "op", op: "merge", payload };
  }
  return { kind: "op", op: "merge", payload: { ...payload, mergeQueue } };
}

// An older PR is ready too and merges first (decision merge-order). The note
// is logged once while the wait lasts.
function queued(data: FinalizerData, note: string): FinalizerData {
  const last = data.log.at(-1) ?? "";
  if (last.includes(note)) {
    return ended(data, { kind: "held" });
  }
  return ended(noted(data, note), { kind: "held" });
}

// The merge's reply: merged (saved at done, or at publish when the wiki's
// changes wait to be published), queued, deferred to the next sync with the
// passed head kept, or refused.
function merged(data: FinalizerData, raw: unknown): FinalizerData {
  const reply = mergeReplyOf(raw);
  const { kind } = reply;
  switch (kind) {
    case "merged":
      if (!reply.published) {
        const note = "merged; the wiki changes wait to be published";
        return ended(noted(data, note), { kind: "saved", stage: "publish" });
      }
      return ended(data, { kind: "saved", stage: "done" });
    case "queued": {
      const { waitingFor, waitingForPr } = reply;
      return queued(
        data,
        `merge waits for #${waitingFor} (older PR #${waitingForPr})`,
      );
    }
    case "deferred": {
      const passedSha = data.st.verifiedSha ?? null;
      let note = "merge deferred: conflict; will rebase next sweep";
      if (reply.reason === "behind") {
        note = "merge deferred: behind; rebasing now";
      }
      const back = { ...noted(data, note), passedSha };
      return ended(back, { kind: "saved", stage: "sync" });
    }
    case "refused":
      return stoppedFor(data, "GitHub refused the merge", reply.reason);
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

const mergeStep: LinearStep<FinalizerData> = {
  name: "merge",
  kind: "script",
  skip: (data: FinalizerData): boolean => data.end !== null,
  effect: mergeEffect,
  apply: merged,
  recover: (data: FinalizerData, error: string): FinalizerData =>
    opFailed(data, "merge", "the merge step failed", error),
};

const finalizerScript: LinearScript<FinalizerData> = {
  locate,
  steps: [
    wikiSyncStep,
    resolveStep,
    finishWikiSyncStep,
    wikiCheckStep,
    mergeStep,
  ],
  end: endOf,
  handoff: ["log", "conflictFixes", "continuations", "passedSha"],
  checkpoints: ["conflictFixes"],
};

export { finalizerScript };
