// Local stop reconciliation evidence, never GitHub authority. A write-ahead
// record survives a failed/killed ops child; confirmed steps are acknowledged
// updates (state additionally requires an authoritative reread). No mutation is
// retried here: a lost write response stays unresolved for the operator.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config, Identity } from "./config.ts";
import { credential, paths } from "./config.ts";
import type { IssueState } from "./state.ts";

const IDENTITIES: readonly Identity[] = ["dev", "merge"];
const DIAGNOSTIC_LIMIT = 8192;
const TOKEN = /gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/gu;
const RECOVERY_ID = z.uuid();
const RECORD = z.object({
  version: z.literal(1),
  authority: z.literal("local evidence only; not signed authority"),
  result: z.enum(["reconciliation-required", "signed-stop-confirmed"]),
  issue: z.number().int().positive(),
  repo: z.string(),
  branch: z.string(),
  resumeStage: z.string().nullable(),
  resumeStageSource: z.enum(["request snapshot", "saved authority"]),
  stopCode: z.string(),
  originalFailure: z.string(),
  stopFailure: z.string().nullable(),
  updates: z.record(z.string(), z.enum(["confirmed", "unresolved"])),
  recovery: z.string(),
});

type Evidence = z.infer<typeof RECORD>;
interface StopRecovery {
  id: string;
  file: string;
  plan: (state: IssueState) => void;
  confirm: (...updates: readonly string[]) => void;
  fail: (failure: string) => string;
  complete: () => void;
}

function redacted(cfg: Config, text: string): string {
  let safe = text;
  for (const identity of IDENTITIES) {
    try {
      safe = safe.replaceAll(credential(cfg, identity), "<token>");
    } catch {
      // Missing credentials cannot authorize a call; keep recovery available.
    }
  }
  safe = safe.replace(TOKEN, "<token>");
  if (safe.length > DIAGNOSTIC_LIMIT) {
    return `${safe.slice(0, DIAGNOSTIC_LIMIT)}… [truncated]`;
  }
  return safe;
}

interface StopIntent {
  number: number;
  state: IssueState;
  code: string;
  reason: string;
  recoveryId?: string | undefined;
}

function initialEvidence(cfg: Config, intent: StopIntent): Evidence {
  const { number: issue, state, code, reason } = intent;
  const targets = [issue];
  if (state.pr !== null) {
    targets.push(state.pr);
  }
  const evidence: Evidence = {
    version: 1,
    authority: "local evidence only; not signed authority",
    result: "reconciliation-required",
    issue,
    repo: cfg.repo,
    branch: paths.branch(cfg, issue),
    resumeStage: state.stage,
    resumeStageSource: "request snapshot",
    stopCode: code,
    originalFailure: redacted(cfg, reason),
    stopFailure: null,
    updates: Object.fromEntries([
      ["state", "unresolved"],
      ["lease", "unresolved"],
      ["claim", "unresolved"],
      ...targets.flatMap((target) => [
        [`explanation:${target}`, "unresolved"],
        [`labels:${target}`, "unresolved"],
        [`working-label:${target}`, "unresolved"],
      ]),
    ]),
    recovery:
      "Stop dispatch. Retain remote code/private-wiki commits, saved receipts and local recovery artifacts. Read GitHub state/editor provenance, lease, live claims and issue/PR labels; reconcile every unresolved update and the original failure before an explicitly authorized restart on the same issue/branch/resume stage. A lost response may have landed. This file grants no write, hardening or restart authority; exact saved-authority/head checks still apply. Never infer hardening from passed checks or pushed commits.",
  };
  if (state.stage === "stopped") {
    evidence.resumeStage = state.stoppedStage;
  }
  if (state.stage === "done") {
    evidence.resumeStage = "merge";
  }
  return evidence;
}

function writeEvidence(file: string, value: Evidence): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}

function stopRecovery(cfg: Config, intent: StopIntent): StopRecovery {
  const id = RECOVERY_ID.parse(intent.recoveryId ?? randomUUID());
  const file = path.join(
    paths.runDir(cfg, intent.number),
    "stop-recovery",
    `${id}.json`,
  );
  function update(change: (value: Evidence) => void): void {
    const value = RECORD.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    change(value);
    writeEvidence(file, value);
  }
  // The parent and child share this id. Never overwrite the child's progress.
  if (!fs.existsSync(file)) {
    writeEvidence(file, initialEvidence(cfg, intent));
  }
  return {
    id,
    file,
    plan: (state: IssueState): void =>
      update((value) => {
        const fresh = initialEvidence(cfg, { ...intent, state });
        value.result = "reconciliation-required";
        value.stopCode = fresh.stopCode;
        value.updates = fresh.updates;
        value.resumeStage = fresh.resumeStage;
        value.resumeStageSource = "saved authority";
      }),
    confirm: (...updates): void =>
      update((value) => {
        for (const key of updates) {
          value.updates[key] = "confirmed";
        }
      }),
    fail: (failure: string): string => {
      update((value) => {
        value.stopFailure ??= redacted(cfg, failure);
      });
      return `reconciliation-required: ${file}; ${redacted(cfg, failure)}`;
    },
    complete: (): void =>
      update((value) => {
        value.result = "signed-stop-confirmed";
      }),
  };
}

export { stopRecovery };
