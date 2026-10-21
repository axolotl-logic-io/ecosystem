// Append-only local recovery evidence. Files and bundles are synced before they
// become visible; they are not GitHub authority and never overwrite receipts.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import type { Intent, Preparation, Selection } from "./schema.ts";
import {
  ABANDONED,
  COMPLETION,
  ID,
  INTENT,
  OPERATOR_DECISION,
  PREPARATION,
  SELECTION,
} from "./schema.ts";

const COMMAND_MS = 30_000;
const MAX_RECORDS = 100;
const MAX_RECORD_BYTES = 1_048_576;

function localGit(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args], {
    timeoutMs: COMMAND_MS,
  }).stdout.trim();
}
function syncFile(file: string): void {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function durableDirectory(dir: string): void {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (first === undefined) {
    return;
  }
  const until = path.dirname(first);
  let ancestor = dir;
  for (;;) {
    syncFile(ancestor);
    if (ancestor === until) {
      return;
    }
    ancestor = path.dirname(ancestor);
  }
}

function durableJson(file: string, data: object): void {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== `${JSON.stringify(data)}\n`) {
      throw new OpsError(
        "conflicting wiki recovery evidence; explicit operator reconciliation required",
      );
    }
    syncFile(file);
    syncFile(path.dirname(file));
    return;
  }
  const dir = fs.mkdtempSync(path.join(path.dirname(file), ".write-"));
  const temp = path.join(dir, "record");
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    syncFile(temp);
    fs.linkSync(temp, file);
    syncFile(path.dirname(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function recoveryRoot(cfg: Config, issue: number): string {
  return path.join(paths.runDir(cfg, issue), "wiki-sync");
}
function recordDir(cfg: Config, issue: number, id: string): string {
  return path.join(recoveryRoot(cfg, issue), ID.parse(id));
}
function newRecordDir(cfg: Config, issue: number): { id: string; dir: string } {
  const root = recoveryRoot(cfg, issue);
  durableDirectory(root);
  const id = randomUUID();
  const dir = recordDir(cfg, issue, id);
  fs.mkdirSync(dir);
  syncFile(root);
  return { id, dir };
}
function recordIds(cfg: Config, issue: number): string[] {
  const root = recoveryRoot(cfg, issue);
  if (!fs.existsSync(root)) {
    return [];
  }
  const ids = fs.readdirSync(root);
  if (ids.length > MAX_RECORDS || ids.some((id) => !ID.safeParse(id).success)) {
    throw new OpsError(
      "wiki recovery evidence is incomplete or exceeds the bounded scan; explicit operator reconciliation required",
    );
  }
  return ids;
}
function evidenceText(file: string): string {
  if (fs.statSync(file).size > MAX_RECORD_BYTES) {
    throw new OpsError(
      "wiki recovery evidence exceeds the bounded read; explicit operator reconciliation required",
    );
  }
  return fs.readFileSync(file, "utf8");
}
function readRecord<T>(file: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(evidenceText(file)));
  } catch (cause) {
    throw new OpsError(
      `unreadable wiki recovery evidence ${file}; explicit operator reconciliation required`,
      { cause },
    );
  }
}
function preserveHistory(
  dir: string,
  repo: string,
  name: string,
  refs: readonly string[],
): void {
  const bundle = path.join(dir, `${name}.bundle`);
  localGit(repo, ["bundle", "create", bundle, ...refs]);
  localGit(repo, ["bundle", "verify", bundle]);
  syncFile(bundle);
  syncFile(dir);
}
function readPreparation(cfg: Config, issue: number, id: string): Preparation {
  const prep = readRecord(
    path.join(recordDir(cfg, issue, id), "preparation.json"),
    PREPARATION,
  );
  if (prep.id !== id) {
    throw new OpsError("wiki recovery identity conflict");
  }
  return prep;
}

function keepTip(
  dir: string,
  prep: Preparation,
  name: string,
  sha: string,
): string {
  const ref = `refs/pipeline/wiki-sync/${prep.id}/${name}`;
  localGit(dir, ["update-ref", ref, sha, ""]);
  return ref;
}
function readOperatorSelection(folder: string, id: string): Selection {
  const decision = readRecord(
    path.join(folder, "operator.json"),
    OPERATOR_DECISION,
  );
  const selection = readRecord(path.join(folder, "selection.json"), SELECTION);
  if (
    selection.id !== id ||
    selection.kind !== "operator" ||
    decision.rationale !== selection.basis ||
    createHash("sha256").update(decision.evidence).digest("hex") !==
      decision.sha256 ||
    fs.existsSync(path.join(folder, "intent.json")) ||
    fs.existsSync(path.join(folder, "completion.json")) ||
    fs.existsSync(path.join(folder, "abandoned.json"))
  ) {
    throw new OpsError("operator selection decision evidence conflicts");
  }
  return selection;
}
function readSyncIntent(folder: string, id: string): Intent {
  const intent = readRecord(path.join(folder, "intent.json"), INTENT);
  if (
    intent.id !== id ||
    fs.existsSync(path.join(folder, "abandoned.json")) ||
    fs.existsSync(path.join(folder, "operator.json"))
  ) {
    throw new OpsError("conflicting wiki sync intent evidence");
  }
  return intent;
}
function assertUniqueWikiIntent(
  cfg: Config,
  issue: number,
  id: string,
  next: string,
): void {
  for (const other of recordIds(cfg, issue).filter((value) => value !== id)) {
    const folder = recordDir(cfg, issue, other);
    readPreparation(cfg, issue, other);
    assertPushComplete(folder, other);
    const otherFile = path.join(folder, "intent.json");
    if (
      fs.existsSync(otherFile) &&
      readSyncIntent(folder, other).new === next
    ) {
      throw new OpsError("conflicting attribution of the synced wiki tip");
    }
  }
}
function assertNoUncertainWikiPush(cfg: Config, issue: number): void {
  for (const id of recordIds(cfg, issue)) {
    readPreparation(cfg, issue, id);
    assertPushComplete(recordDir(cfg, issue, id), id);
  }
}
function assertPushComplete(folder: string, id: string): void {
  if (fs.existsSync(path.join(folder, "operator.json"))) {
    readOperatorSelection(folder, id);
    return;
  }
  const intentFile = path.join(folder, "intent.json");
  if (
    !fs.existsSync(intentFile) &&
    fs.existsSync(path.join(folder, "completion.json"))
  ) {
    throw new OpsError("conflicting wiki completion without original intent");
  }
  if (
    !(
      fs.existsSync(intentFile) ||
      fs.existsSync(path.join(folder, "abandoned.json"))
    )
  ) {
    throw new OpsError(
      "incomplete wiki sync preparation; explicit operator reconciliation required before any push",
    );
  }
  if (
    !fs.existsSync(intentFile) &&
    readRecord(path.join(folder, "abandoned.json"), ABANDONED).id !== id
  ) {
    throw new OpsError("conflicting abandoned wiki sync preparation");
  }
  if (fs.existsSync(intentFile)) {
    const intent = readSyncIntent(folder, id);
    const file = path.join(folder, "completion.json");
    if (!fs.existsSync(file)) {
      throw new OpsError(
        "unresolved wiki push intent; explicitly reconcile without repeating the push",
      );
    }
    const completion = readRecord(file, COMPLETION);
    if (
      intent.id !== id ||
      completion.id !== id ||
      intent.new !== completion.new
    ) {
      throw new OpsError("conflicting wiki push completion evidence");
    }
  }
}

export {
  assertNoUncertainWikiPush,
  assertPushComplete,
  assertUniqueWikiIntent,
  COMMAND_MS,
  durableJson,
  evidenceText,
  keepTip,
  localGit,
  newRecordDir,
  preserveHistory,
  readOperatorSelection,
  readPreparation,
  readRecord,
  readSyncIntent,
  recordDir,
  recordIds,
};
