// A local selection explains only an exact wiki rewrite; it grants no verification.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { rebaseInProgress } from "../rebase.ts";
import { readWriteState } from "../saved-state.ts";
import type { Revision } from "../state.ts";
import { mergeAuthorization, sameRevision } from "../state.ts";
import {
  assertRemote,
  configuredWikiRemote,
  validatePreparation,
} from "./authority.ts";
import {
  assertUniqueWikiIntent,
  localGit,
  readOperatorSelection,
  readPreparation,
  readRecord,
  recordDir,
  recordIds,
} from "./records.ts";
import type { Preparation, Selection } from "./schema.ts";
import { COMPLETION, INTENT, OID, SELECTION } from "./schema.ts";

const MAX_BRANCHES = 100;

function importHistory(
  cfg: Config,
  prep: Preparation,
  next: string,
  mirror: string,
): string {
  const folder = recordDir(cfg, prep.issue, prep.id);
  for (const name of ["before", "after"]) {
    const bundle = path.join(folder, `${name}.bundle`);
    localGit(mirror, ["bundle", "verify", bundle]);
    localGit(mirror, [
      "fetch",
      "--quiet",
      bundle,
      `refs/pipeline/wiki-sync/${prep.id}/*:refs/pipeline/wiki-sync/${prep.id}/*`,
    ]);
  }
  for (const [name, sha] of [
    ["old", prep.old],
    ["target", prep.target],
    ["new", next],
  ]) {
    if (
      localGit(mirror, [
        "rev-parse",
        `refs/pipeline/wiki-sync/${prep.id}/${name}`,
      ]) !== sha
    ) {
      throw new OpsError("retained wiki history conflicts with checkpoint");
    }
  }
  const ancestor = localGit(mirror, ["merge-base", prep.target, next]);
  if (ancestor !== prep.target) {
    throw new OpsError("synced wiki does not contain the exact rebase target");
  }
  return `refs/pipeline/wiki-sync/${prep.id}/new`;
}
function privateTip(mirror: string, branch: string): string {
  return OID.parse(localGit(mirror, ["rev-parse", `refs/heads/${branch}`]));
}
function retainedWork(prep: Preparation, next: string, retained: string): void {
  auditRetainedWork(prep, next, retained);
  // A supplied relocation must not hide a still-present dirty original checkout.
  if (
    fs.existsSync(prep.checkout) &&
    fs.realpathSync(prep.checkout) !== fs.realpathSync(retained)
  ) {
    auditRetainedWork(prep, next, prep.checkout);
  }
}
function auditRetainedWork(
  prep: Preparation,
  next: string,
  retained: string,
): void {
  if (
    !(path.isAbsolute(retained) && fs.existsSync(path.join(retained, ".git")))
  ) {
    throw new OpsError(
      "a preserved wiki checkout is required for explicit reconciliation",
    );
  }
  const tip = localGit(retained, ["rev-parse", "HEAD"]);
  const branches = localGit(retained, ["for-each-ref", "refs/heads"]);
  const branchLines = branches.split("\n").filter(Boolean);
  if (branchLines.length > MAX_BRANCHES) {
    throw new OpsError(
      "retained wiki branches exceed the bounded reconciliation scan",
    );
  }
  const extra = branchLines.some((line) => {
    const [branchTip] = line.split(" ");
    return (
      localGit(retained, [
        "rev-list",
        "--count",
        OID.parse(branchTip),
        "--not",
        prep.old,
        next,
        prep.target,
      ]) !== "0"
    );
  });
  if (
    extra ||
    rebaseInProgress(retained) ||
    localGit(retained, ["status", "--porcelain", "--untracked-files=all"]) !==
      "" ||
    (tip !== prep.old && tip !== next)
  ) {
    throw new OpsError(
      "additional retained wiki work requires explicit reconciliation; checkout and histories retained",
    );
  }
}
function validateSelection(
  cfg: Config,
  issue: number,
  prep: Preparation,
  selection: Selection,
): void {
  const folder = recordDir(cfg, issue, prep.id);
  if (selection.id !== prep.id || selection.private !== prep.old) {
    throw new OpsError(
      "wiki selection conflicts with its original private history",
    );
  }
  if (selection.kind === "checkpoint") {
    const intent = readRecord(path.join(folder, "intent.json"), INTENT);
    const completion = readRecord(
      path.join(folder, "completion.json"),
      COMPLETION,
    );
    if (
      intent.id !== prep.id ||
      completion.id !== prep.id ||
      intent.new !== selection.new ||
      completion.new !== selection.new
    ) {
      throw new OpsError("wiki selection has no exact completion evidence");
    }
  } else {
    readOperatorSelection(folder, prep.id);
  }
}
function selectedWikiStart(
  cfg: Config,
  issue: number,
  mirror: string,
  remote: string,
): { ref: string; prep: Preparation; selection: Selection } | null {
  const selected = recordIds(cfg, issue).filter((id) =>
    fs.existsSync(path.join(recordDir(cfg, issue, id), "selection.json")),
  );
  if (selected.length === 0) {
    return null;
  }
  // Multiple records may exist, but only an exact pair can justify this selection.
  const privateHead = privateTip(mirror, paths.branch(cfg, issue));
  const remoteHead = localGit(mirror, [
    "rev-parse",
    `refs/remotes/origin/${paths.branch(cfg, issue)}`,
  ]);
  const candidates = selected
    .map((id) => ({
      prep: readPreparation(cfg, issue, id),
      selection: readRecord(
        path.join(recordDir(cfg, issue, id), "selection.json"),
        SELECTION,
      ),
    }))
    .filter(
      ({ selection: saved }) =>
        saved.new === remoteHead &&
        (saved.private === privateHead || saved.new === privateHead),
    );
  const [candidate] = candidates;
  if (candidates.length !== 1 || candidate === undefined) {
    throw new OpsError(
      "wiki recovery selection no longer matches exact refs; explicit operator reconciliation required",
    );
  }
  const { prep, selection } = candidate;
  assertUniqueWikiIntent(cfg, issue, prep.id, selection.new);
  validateSelection(cfg, issue, prep, selection);
  validatePreparation(cfg, issue, prep, {
    lane: selectionLane(cfg, prep),
    next: selection.new,
  });
  if (selection.id !== prep.id || remote !== prep.remote) {
    throw new OpsError("wiki recovery selection identity conflict");
  }
  assertRemote(cfg, mirror);
  assertRemote(cfg, selection.retained);
  retainedWork(prep, selection.new, selection.retained);
  const ref = importHistory(cfg, prep, selection.new, mirror);
  return { ref, prep, selection };
}
// Checkout selection needs a caller-provided stable lane, not one inferred from evidence.
function selectionLane(cfg: Config, prep: Preparation): string {
  if (cfg.recoveryLane === undefined || cfg.recoveryLane !== prep.lane) {
    throw new OpsError(
      "wiki recovery requires the same explicitly assigned stable lane",
    );
  }
  return cfg.recoveryLane;
}
function recoveredWikiRevision(
  cfg: Config,
  issue: number,
  lane: string,
  current: Revision,
): boolean {
  // A selection is only an entry into integration from the original code head.
  // Once integration has moved/saved authority this cannot authorize another head.
  const matching = recordIds(cfg, issue).filter((id) => {
    const file = path.join(recordDir(cfg, issue, id), "selection.json");
    if (!fs.existsSync(file)) {
      return false;
    }
    const selection = readRecord(file, SELECTION);
    const prep = readPreparation(cfg, issue, id);
    const original = mergeAuthorization(prep.authority);
    return (
      original !== null &&
      current.code === original.code &&
      current.inputs === original.inputs &&
      current.wiki === selection.new
    );
  });
  if (matching.length === 0) {
    return false;
  }
  const authorized = mergeAuthorization(readWriteState(cfg, issue));
  if (authorized !== null && sameRevision(authorized, current)) {
    return false;
  }
  const mirror = paths.wikiMirror(cfg);
  return (
    selectedWikiStart(
      { ...cfg, recoveryLane: lane },
      issue,
      mirror,
      configuredWikiRemote(cfg),
    ) !== null
  );
}

export {
  importHistory,
  privateTip,
  recoveredWikiRevision,
  retainedWork,
  selectedWikiStart,
};
