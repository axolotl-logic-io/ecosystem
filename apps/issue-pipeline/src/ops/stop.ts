// The stop op: stops an issue at a failed control. It labels the issue and
// its PR agent:stopped-<code>, and explains on both which control stopped it,
// why, and how to resume.

import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import { closeClaims } from "../claims.ts";
import type { Author } from "../comments.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { applyStopLabel } from "../labels.ts";
import { OpsError } from "../ops-error.ts";
import { redactLocalPaths } from "../pipeline-root.ts";
import { parseRequest } from "../process.ts";
import { redactAddresses } from "../redact-addresses.ts";
import { readWriteState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { ISSUE_STATE, withLog } from "../state.ts";
import { stopRecovery } from "../stop-recovery.ts";
import type { Stop } from "../stops.ts";
import { STOPS, stopFor } from "../stops.ts";
import { pushUnpushed } from "../unpushed.ts";
import { saveIssueState } from "./save-state.ts";

// The catch-all stop, for a reason no other control names.
const ERROR_CODE = "error";

const STOP_REQUEST = z.looseObject({
  recoveryId: z.uuid().optional(),
  code: z.string().nullish(),
  detail: z.string().nullish(),
  nextStep: z.string().nullish(),
  number: z.number().int().positive(),
  reason: z.string().min(1),
  state: ISSUE_STATE,
});

// The stage whose commits a stop pushes first, since only open-pr pushes
// them otherwise (#283).
const IMPLEMENT_STAGE = "implement";

type StopRequest = z.infer<typeof STOP_REQUEST>;

const COORDINATOR: Author = { role: "coordinator" };

// The stop `code` names, or else the one `reason` names, or else `error`.
function stopOf(
  code: string | null | undefined,
  reason: string | null | undefined,
): Stop {
  const named =
    STOPS.find((control) => control.code === code) ??
    stopFor(reason) ??
    STOPS.find((control) => control.code === ERROR_CODE);
  if (named === undefined) {
    throw new OpsError(`no "${ERROR_CODE}" stop`);
  }
  return named;
}

function detailLine(detail: string | null | undefined): string {
  if (detail === undefined || detail === null || detail === "") {
    return "";
  }
  return `\n${detail}`;
}

function nextStepText(control: Stop, req: StopRequest): string {
  const { nextStep } = req;
  if (nextStep !== undefined && nextStep !== null && nextStep !== "") {
    return nextStep;
  }
  if (req.state.mergeAttempt !== null) {
    return "Code may already have landed. Do not retry the merge POST, repeat approval, push code, or reset merged/security/attempt state. Preserve response evidence and original authorization. With unchanged inputs and identity, the operator may authorize one bounded restart at merge with a new finite confirmation window, using the saved response and cumulative read evidence without resetting them. Deadline expiry requires explicit reconciliation, not an unattended restart loop.";
  }
  if (req.state.codeMerged !== null) {
    return `To resume, fix what this names, then remove \`${control.label.name}\`. The PR has merged, so the next job checks and reviews the merged result again, with every limit reset.`;
  }
  return `To resume, fix what this names (push to the branch if you like), then remove \`${control.label.name}\`. The next sweep continues at the stage that stopped, from the PR's branch, with every limit reset; a stage after review goes back to review if the branch moved since it.`;
}

function stopComment(
  control: Stop,
  req: StopRequest,
  unpushed: readonly string[],
): string {
  return [
    `**🛑 Stopped by a control: ${control.control}** (\`${control.label.name}\`)`,
    "",
    control.explain,
    "",
    `Reason: ${String(req.reason)}`,
    detailLine(req.detail),
    ...unpushed.map((line) => `\n${line}`),
    "",
    nextStepText(control, req),
  ].join("\n");
}

// `state` stopped by `control` for `reason`: a lifted stop resumes at the
// stage that stopped. A completion (done) that stopped resumes at merge,
// whose job reconciles it again.
function stoppedState(
  state: IssueState,
  control: Stop,
  reason: string,
): IssueState {
  const { stage, stoppedStage: savedStoppedStage } = state;
  let stoppedStage = savedStoppedStage;
  if (stage === "done") {
    stoppedStage = "merge";
  } else if (stage !== "stopped") {
    stoppedStage = stage;
  }
  const stopped: IssueState = {
    ...state,
    stage: "stopped",
    stoppedStage,
    lease: null,
    stopCode: control.code,
  };
  return withLog(stopped, `stopped (${control.code}): ${reason}`, new Date());
}

function stop(
  cfg: Config,
  request: unknown,
): { code: string; label: string; state: IssueState } {
  const input = parseRequest(STOP_REQUEST, "stop", request);
  const found = stopOf(input.code, input.reason);
  const recovery = stopRecovery(cfg, { ...input, code: found.code });
  try {
    return performStop(cfg, input, found, recovery);
  } catch (error: unknown) {
    let failure = String(error);
    if (error instanceof Error) {
      failure = error.message;
    }
    throw new OpsError(recovery.fail(failure), { cause: error });
  }
}

function performStop(
  cfg: Config,
  input: StopRequest,
  found: Stop,
  recovery: ReturnType<typeof stopRecovery>,
): { code: string; label: string; state: IssueState } {
  const n = input.number;
  const saved = readWriteState(cfg, n);
  assignedBranch(cfg, n, saved);
  recovery.plan(saved);
  // Stops do not grant or rewrite authority. Preserve durable provenance,
  // including security rejection, over stale or forged request snapshots.
  const req = {
    ...input,
    state: { ...saved, counts: input.state.counts, log: input.state.log },
  };
  const { stage } = req.state;
  const prNumber = req.state.pr ?? 0;
  let unpushed: string[] = [];
  if (stage === IMPLEMENT_STAGE) {
    unpushed = pushUnpushed(cfg, n);
  }
  const body = stopComment(found, req, unpushed);
  comment(cfg, n, COORDINATOR, body);
  recovery.confirm(`explanation:${n}`);
  if (prNumber !== 0) {
    comment(cfg, prNumber, COORDINATOR, body);
    recovery.confirm(`explanation:${prNumber}`);
  }
  const state = saveIssueState(
    cfg,
    n,
    stoppedState(req.state, found, req.reason),
  );
  const confirmed = readWriteState(cfg, n);
  if (
    JSON.stringify(confirmed) !==
    redactAddresses(redactLocalPaths(JSON.stringify(state)))
  ) {
    throw new OpsError(
      "signed stopped state could not be confirmed by authoritative reread",
    );
  }
  recovery.confirm("state", "lease");
  for (const target of [n, prNumber].filter((number) => number !== 0)) {
    applyStopLabel(cfg, target, found.label.name, () => {
      recovery.confirm(`working-label:${target}`);
    });
    recovery.confirm(`labels:${target}`);
  }
  closeClaims(
    cfg,
    n,
    `the issue stopped (\`${found.label.name}\`); removing the label puts it back in the queue.`,
  );
  recovery.confirm("claim");
  recovery.complete();
  return { code: found.code, label: found.label.name, state };
}

export { stop };
