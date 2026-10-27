#!/usr/bin/env node
// Explicit operator settlement of an interrupted, pre-effect Implement.
// It resumes no task and replays no effect. Observations supply exit and
// preservation evidence; the operator's --apply and the authenticated
// original attempt and ownership authorize this bounded cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Config } from "../src/config.ts";
import { loadConfig, paths } from "../src/config.ts";
import { confirmedWrite } from "../src/coordination-journal.ts";
import {
  issueExecution,
  resourceSlot,
  resourceSurvey,
  withExecution,
} from "../src/execution.ts";
import { gh, ghJson } from "../src/github.ts";
import { issueRefusal } from "../src/job/release-predicate.ts";
import { freshRecords, settleRun } from "../src/ops/task-ledger.ts";
import { ROOT } from "../src/pipeline-root.ts";
import { RESOURCE_CAPACITY } from "../src/project-policy-schema.ts";
import type { ActionRunObservation } from "../src/runtime/observations.ts";
import {
  ACTION_RUN,
  actionRunFile,
  BUDDY_RUN,
  buddyRunFile,
} from "../src/runtime/observations.ts";
import type { Attempt, Row } from "../src/tasks/records.ts";
import { determined, isAttempt } from "../src/tasks/records.ts";

const MAX_REASON = 1000;
const REQUEST = z.strictObject({
  config: z.string().min(1),
  issue: z.coerce.number().int().positive(),
  action: z.uuid(),
  reason: z.string().min(1).max(MAX_REASON),
  apply: z.boolean().default(false),
});
const NO_PROCESS = z.looseObject({ code: z.literal("ESRCH") });
const PRE_EFFECT_OPS = new Set(["task-attempt", "prepare-checkout"]);
const NOT_FOUND = /HTTP 404/u;
const WRITE_JOURNAL =
  /^coordination-(?:uncertain(?:-\d+)?|inflight-\d+)\.json$/u;
const PULLS = z.array(z.strictObject({ number: z.int().positive() }));

function refuse(reason: string): never {
  throw new Error(`Implement recovery refused: ${reason}`);
}

function assertExited(pid: number | null): void {
  if (pid === null) {
    refuse("a started consumer has no recorded process identity");
  }
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    if (NO_PROCESS.safeParse(error).success) {
      return;
    }
    refuse("a process exit cannot be verified");
  }
  refuse(`process ${pid} is still present; stop and drain participants first`);
}

function json(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertStoppedBuddies(): void {
  const dir = path.join(ROOT, "runs", "buddy-runs");
  for (const id of fs.readdirSync(dir)) {
    const run = BUDDY_RUN.parse(json(buddyRunFile(id)));
    if (run.process.host !== os.hostname() || run.state !== "stopped") {
      refuse(
        "every observed buddy must have stopped cooperatively on this host",
      );
    }
    assertExited(run.process.pid);
  }
}

function assertPreserved(cfg: Config, run: ActionRunObservation): void {
  if (run.checkpoint.state === "uncertain" || run.preserved.checkout !== null) {
    refuse("a checkpoint or retained checkout still needs reconciliation");
  }
  const root = fs.realpathSync(paths.runDir(cfg, run.workItem.number));
  for (const saved of run.preserved.patches) {
    const file = fs.realpathSync(path.resolve(root, saved));
    if (
      !(file.startsWith(`${root}${path.sep}`) && fs.statSync(file).isFile())
    ) {
      refuse("a preserved patch is absent or outside the run directory");
    }
  }
}

function assertPreEffect(run: ActionRunObservation): void {
  if (run.task !== "implement" || run.mode !== "act" || run.state !== "ended") {
    refuse("only an ended original Implement action is supported");
  }
  if (run.checkpoint.state !== "none") {
    refuse("checkpointed work requires task-owned reconciliation");
  }
  for (const operation of run.operations) {
    if (
      !PRE_EFFECT_OPS.has(operation.op) ||
      operation.endedAt === null ||
      operation.outcome !== "ok"
    ) {
      refuse("an operation may have made an unsettled effect");
    }
  }
  for (const session of run.sessions) {
    if (session.parent !== run.id || session.endedAt === null) {
      refuse("a model consumer has no confirmed exit observation");
    }
    assertExited(session.pid);
  }
}

// Ordinary dispatch may coexist with a live writer. Operator settlement
// may not: even a reused PID cannot make an old in-flight journal safe.
function assertNoJournals(cfg: Config, issue: number): void {
  const dir = paths.runDir(cfg, issue);
  if (
    fs.existsSync(dir) &&
    fs.readdirSync(dir).some((name) => WRITE_JOURNAL.test(name))
  ) {
    refuse(
      "a write journal still exists; reconcile its exact intent before operator settlement",
    );
  }
}

function assertUnpublished(cfg: Config, run: ActionRunObservation): void {
  const ref = gh(
    cfg,
    "landing",
    ["api", `repos/${cfg.repo}/git/ref/heads/${run.execution.branch}`],
    { allowFail: true },
  );
  if (ref.code === 0 || !NOT_FOUND.test(ref.stderr)) {
    refuse(
      "the work branch exists or cannot be read; use task-owned reconciliation",
    );
  }
  const pulls = PULLS.parse(
    ghJson(cfg, "landing", [
      "pr",
      "list",
      "--repo",
      cfg.repo,
      "--state",
      "all",
      "--head",
      run.execution.branch,
      "--json",
      "number",
    ]),
  );
  if (pulls.length > 0) {
    refuse("published PR work requires task-owned reconciliation");
  }
}

function originalAttempt(cfg: Config, run: ActionRunObservation): Row<Attempt> {
  const records = freshRecords(cfg, run.workItem.number);
  const attempt = records.rows
    .filter(isAttempt)
    .find((row) => row.run.id === run.id);
  if (
    attempt === undefined ||
    attempt.buddyRun !== run.buddyRun ||
    JSON.stringify(attempt.binding) !== JSON.stringify(run.binding) ||
    JSON.stringify(attempt.cause) !== JSON.stringify(run.cause)
  ) {
    refuse("the authenticated original attempt does not match the observation");
  }
  const result = determined(records.rows, run.id);
  if (result !== undefined && result.verdict !== "failed") {
    refuse("the original run already has another determined verdict");
  }
  return attempt;
}

function recover(request: z.infer<typeof REQUEST>): void {
  assertStoppedBuddies();
  const loaded = loadConfig(request.config);
  if (loaded.coordination.backend !== "github") {
    refuse("drain the legacy GitHub backend before changing it");
  }
  const file = actionRunFile(loaded, request.issue, request.action);
  const run = ACTION_RUN.parse(json(file));
  if (
    run.id !== request.action ||
    run.workItem.number !== request.issue ||
    run.workItem.repo !== loaded.repo ||
    run.execution.instance !== run.id ||
    run.execution.base !== loaded.baseBranch
  ) {
    refuse("the action's original repository/base identity changed");
  }
  assertPreEffect(run);
  assertPreserved(loaded, run);
  assertNoJournals(loaded, request.issue);
  assertUnpublished(loaded, run);
  const refusal = issueRefusal(loaded, request.issue);
  if (refusal !== null) {
    refuse(refusal);
  }
  const cfg = withExecution(loaded, run.execution);
  const issue = issueExecution(cfg, request.issue);
  issue.assertOwner();
  const attempt = originalAttempt(cfg, run);
  const { resources } = cfg;
  const { modelSessions: cap } = RESOURCE_CAPACITY.parse(resources);
  const survey = [...resourceSurvey(cfg, request.issue, "model-session", cap)];
  if (
    survey.some(
      ([, view]) =>
        view.pending.some((row) => row.binding.instance === run.id) &&
        view.owner?.binding.instance !== run.id,
    )
  ) {
    refuse("an unresolved resource request still needs reconciliation");
  }
  const slots = survey.filter(
    ([, view]) => view.owner?.binding.instance === run.id,
  );
  for (const [slot, view] of slots) {
    for (const entry of view.consumers.filter((consumer) => !consumer.done)) {
      const session = run.sessions.find(
        (row) => row.id === entry.consumer.id && row.reservation?.slot === slot,
      );
      if (
        entry.consumer.kind !== "model-session" ||
        session === undefined ||
        session.endedAt === null
      ) {
        refuse("a registered consumer has no matching confirmed process exit");
      }
    }
  }
  if (!request.apply) {
    process.stdout.write(
      `${JSON.stringify({ action: run.id, state: "ready", slots: slots.map(([slot]) => slot), patches: run.preserved.patches.length })}\n`,
    );
    return;
  }
  assertNoJournals(cfg, request.issue);
  const records = freshRecords(cfg, request.issue);
  if (determined(records.rows, run.id) === undefined) {
    const summary = `The operator settled this interrupted Implement run without retrying it. ${request.reason}`;
    confirmedWrite(cfg, request.issue, "operator-settlement-result", {
      evidence: { action: run.id, verdict: "failed", summary },
      write: () => {
        settleRun(cfg, request.issue, records, {
          attempt,
          verdict: "failed",
          receipt: {
            summary,
            evidence: {
              operatorSettlement: true,
              preservedPatches: run.preserved.patches.length,
            },
          },
        });
      },
      confirmed: () => {
        const result = determined(
          freshRecords(cfg, request.issue).rows,
          run.id,
        );
        return (
          result?.verdict === "failed" && result.receipt.summary === summary
        );
      },
    });
  }
  for (const [slot] of slots) {
    const held = resourceSlot(cfg, request.issue, "model-session", {
      slot,
      cap,
    });
    for (const entry of held.consumers()) {
      if (!entry.done) {
        held.report("done", entry.consumer);
      }
    }
    held.release();
  }
  issue.release();
  process.stdout.write(
    `${JSON.stringify({ action: run.id, state: "released", resumed: false })}\n`,
  );
}

try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      action: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  recover(REQUEST.parse(values));
} catch (error: unknown) {
  let message = "recovery failed";
  if (error instanceof Error) {
    ({ message } = error);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
