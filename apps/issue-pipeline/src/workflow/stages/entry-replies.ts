// The checks on the sweep entry's ops replies: the sweep's config and
// candidates, and a won claim's state and paths. They narrow the reply without
// copying it, so the state keeps every field ops saved (its version, lease
// and the rest) when the sweep sends it back.

import type { IssueState, ItemPaths } from "../types.ts";
import { isRecord, isStrings } from "./reply-guards.ts";
import type { SweepCandidate, SweepConfig } from "./types.ts";

type Fields = Readonly<Record<string, unknown>>;

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// An optional override: absent, null, or a record of `isEntry` values.
function isOverrides(
  value: unknown,
  isEntry: (entry: unknown) => boolean,
): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return isRecord(value) && Object.values(value).every(isEntry);
}

function hasStageCounts(cfg: Fields): boolean {
  const { maxTriages, maxSyncs, maxCiFixes, maxFixRounds, ciWaitMinutes } = cfg;
  return [maxTriages, maxSyncs, maxCiFixes, maxFixRounds, ciWaitMinutes].every(
    isNumber,
  );
}

function hasOptionalFields(cfg: Fields): boolean {
  const { maxConflictFixes, maxSpawnsPerRun, practices } = cfg;
  return (
    [maxConflictFixes, maxSpawnsPerRun].every(
      (value) => value === undefined || value === null || isNumber(value),
    ) &&
    (practices === undefined || isStrings(practices))
  );
}

function isSweepConfig(value: unknown): value is SweepConfig {
  if (!isRecord(value)) {
    return false;
  }
  const { repo, baseBranch, sessionTokenCap, issueTokenBudget } = value;
  const { commands, roleBudgets, models } = value;
  return (
    isString(repo) &&
    isString(baseBranch) &&
    isNumber(sessionTokenCap) &&
    isNumber(issueTokenBudget) &&
    isRecord(commands) &&
    hasStageCounts(value) &&
    hasOptionalFields(value) &&
    isOverrides(roleBudgets, isNumber) &&
    isOverrides(models, isString)
  );
}

function isCandidate(value: unknown): value is SweepCandidate {
  if (!isRecord(value)) {
    return false;
  }
  const { number } = value;
  return isNumber(number);
}

function isCandidates(value: unknown): value is SweepCandidate[] {
  return Array.isArray(value) && value.every(isCandidate);
}

function isNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

function isIssueState(value: unknown): value is IssueState {
  if (!isRecord(value)) {
    return false;
  }
  const { stage, depth, allocated, findings } = value;
  return (
    isString(stage) &&
    isNumber(depth) &&
    isNumber(allocated) &&
    Array.isArray(findings)
  );
}

function isItemPaths(value: unknown): value is ItemPaths {
  if (!isRecord(value)) {
    return false;
  }
  const { worktree, issueFile, wiki, handoffFile } = value;
  return (
    isString(worktree) &&
    isString(issueFile) &&
    isString(handoffFile) &&
    (wiki === null || isString(wiki))
  );
}

export {
  isCandidates,
  isIssueState,
  isItemPaths,
  isNumbers,
  isString,
  isSweepConfig,
};
