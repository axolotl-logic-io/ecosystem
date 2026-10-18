// What a rebase that stopped on conflicts is rebasing: the issue's code onto
// the base branch or the branch it is stacked on (stacked.ts), or its wiki
// commits onto the wiki's branch. The conflict
// resolution (sync-conflict.ts) is the same for both; this module holds what
// differs: the resolver's instructions, the request that finishes the
// rebase, and the words the comments use.

import type { Committer } from "../prompts.ts";
import { committerText, FORBIDDEN_GIT } from "../prompts.ts";
import { isRecord } from "./checks-reply.ts";
import type { StackedOn } from "./stacked.ts";
import { stackedOnOf, stackFields, syncOnto } from "./stacked.ts";
import type { StageState } from "./types.ts";

const SHORT_SHA = 12;

// The code worktree's branch onto the repo's base branch, or for a stacked
// issue onto what `stackedOn` says the sync targeted (null: the base, as its
// prerequisite merged), or the wiki checkout's commits onto the wiki's
// `branch`.
type ConflictTarget =
  | { kind: "code"; stackedOn?: StackedOn | null }
  | { kind: "wiki"; branch: string };

const CODE_TARGET: ConflictTarget = { kind: "code" };

// The target carried between the resolution's steps; anything else is a bug
// in the sweep's loop.
function targetOf(value: unknown): ConflictTarget {
  if (isRecord(value)) {
    const { kind, branch } = value;
    const stackedOn = stackedOnOf(value);
    if (kind === "code" && stackedOn !== undefined) {
      return { kind, stackedOn };
    }
    if (kind === "code") {
      return CODE_TARGET;
    }
    if (kind === "wiki" && typeof branch === "string") {
      return { kind, branch };
    }
  }
  throw new Error("conflict: expected the rebase's target");
}

// What the rebase is onto, as a comment names it.
function ontoText(target: ConflictTarget, baseBranch: string): string {
  switch (target.kind) {
    case "code":
      return syncOnto(target.stackedOn, baseBranch);
    case "wiki":
      return `the wiki's ${target.branch}`;
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

// What finishing, or aborting, the resolved rebase asks for.
interface Finish {
  number: number;
  abort: boolean;
  reason: string;
  baseSha: unknown;
}

// The ops request that finishes, or aborts, the resolved rebase. A stacked
// issue's code rebase is checked against what its sync targeted, its
// `stackedOn`; any other code rebase's against the base it stopped on,
// `baseSha`, when it is known (#279).
function finishRequest(
  target: ConflictTarget,
  { number, abort, reason, baseSha }: Finish,
): { op: string; payload: Readonly<Record<string, unknown>> } {
  const payload = { number, abort, reason };
  switch (target.kind) {
    case "code":
      return {
        op: "finish-sync",
        payload: codeFinish(target, payload, baseSha),
      };
    case "wiki":
      return { op: "finish-wiki-sync", payload };
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

// finish-sync's payload: `payload` and what the rebase is checked against.
function codeFinish(
  target: ConflictTarget & { kind: "code" },
  payload: Readonly<Record<string, unknown>>,
  baseSha: unknown,
): Readonly<Record<string, unknown>> {
  const { stackedOn } = target;
  if (stackedOn !== null && stackedOn !== undefined) {
    return { ...payload, ...stackFields(stackedOn) };
  }
  if (typeof baseSha === "string" && baseSha !== "") {
    return { ...payload, baseSha };
  }
  return payload;
}

// What a resolver whose git is `git` (with its -C) may not run. Through
// `pipeline_commit`, it still adds and continues the rebase itself, until a
// lifecycle takes that over (#303).
function gitLimit(committer: Committer, git: string): string {
  return committerText(
    committer,
    "Never run `git rebase --abort`, `git reset` to another commit, or `git push`.",
    `Besides \`${git} add\` and \`GIT_EDITOR=true ${git} rebase --continue\`, never run ${FORBIDDEN_GIT}: no \`git rebase --abort\`, and no \`git reset\` to another commit.`,
  );
}

// A stopped rebase as the resolver's task gives it: the short sha it is
// rebasing onto, the conflicting files' list, and how the resolver commits.
interface Stopped {
  short: string;
  files: string;
  committer: Committer;
}

function codeTask(base: string, stopped: Stopped): string[] {
  const { short, files, committer } = stopped;
  const commit = committerText(
    committer,
    "a new commit",
    "a new commit made with `pipeline_commit`",
  );
  return [
    `The pipeline is rebasing this branch onto origin/${base} (${short}), and the rebase stopped on conflicts in:`,
    files,
    "",
    `Finish the rebase. For each stopped commit, read what ${base} changed in the conflicting files (\`git log -p ORIG_HEAD..origin/${base} -- <file>\` or \`git diff <merge-base> origin/${base} -- <file>\`) and what this branch changed, and write a resolution that keeps the intent of both. Then \`git add\` the files and run \`GIT_EDITOR=true git rebase --continue\`; repeat if a later commit stops too.`,
    `Code that merged without a textual conflict can still break: ${base} may use a name or field this branch renamed or removed. After the rebase finishes, run the repo's type check and the unit tests for the touched areas, and fix what broke in ${commit}, ending with the trailer line \`Pipeline-Agent: conflict resolver\`. The pipeline runs the full checks afterwards.`,
    `${gitLimit(committer, "git")} Leave the rebase finished and the worktree clean. No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what ${base} now does and re-apply this branch's change on top of it as far as it still makes sense, and say in your summary what you chose. Return \`cannot-fix\` only if you could not finish the rebase at all; a fresh resolver then tries again next sweep.`,
  ];
}

function wikiTask(wiki: string, branch: string, stopped: Stopped): string[] {
  const { short, files, committer } = stopped;
  return [
    `The pipeline is rebasing this issue's wiki commits, in the wiki checkout ${wiki}, onto the wiki's origin/${branch} (${short}), and the rebase stopped on conflicts in:`,
    files,
    "",
    `Finish the rebase in that checkout. For each stopped commit, read what the wiki's ${branch} changed in the conflicting pages (\`git -C ${wiki} log -p ORIG_HEAD..origin/${branch} -- <page>\`) and what this issue's commits changed, and write a resolution that keeps the intent of both. Then \`git -C ${wiki} add\` the pages and run \`GIT_EDITOR=true git -C ${wiki} rebase --continue\`; repeat if a later commit stops too.`,
    `${gitLimit(committer, `git -C ${wiki}`)} Leave the rebase finished and the wiki checkout clean. No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what the wiki's ${branch} now says and re-apply this issue's change on top of it as far as it still makes sense, and say in your summary what you chose. Return \`cannot-fix\` only if you could not finish the rebase at all; a fresh resolver then tries again next sweep.`,
  ];
}

// The resolver's instructions, after its preamble, for a resolver that
// commits with `committer`.
function resolverTask(
  state: StageState,
  target: ConflictTarget,
  conflict: { base: string; files: readonly string[]; baseSha: unknown },
  committer: Committer,
): string[] {
  const stopped: Stopped = {
    short: String(conflict.baseSha).slice(0, SHORT_SHA),
    files: conflict.files.map((file) => `- ${file}`).join("\n"),
    committer,
  };
  switch (target.kind) {
    case "code":
      return codeTask(conflict.base, stopped);
    case "wiki":
      return wikiTask(String(state.paths.wiki), target.branch, stopped);
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

export type { ConflictTarget };
export { CODE_TARGET, finishRequest, ontoText, resolverTask, targetOf };
