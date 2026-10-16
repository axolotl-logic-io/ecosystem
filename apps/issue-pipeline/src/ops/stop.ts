// The stop op: stops an issue at a failed control. It labels the issue and
// its PR agent:stopped-<code>, and explains on both which control stopped it,
// why, and how to resume.

import { z } from "zod";
import { closeClaims } from "../claims.ts";
import type { Author } from "../comments.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { OpsError } from "../process.ts";
import { writeState } from "../state.ts";
import type { Stop } from "../stops.ts";
import { STOPS, stopFor } from "../stops.ts";
import { pushUnpushed } from "../unpushed.ts";

// The catch-all stop, for a reason no other control names.
const ERROR_CODE = "error";

const STOP_REQUEST = z.looseObject({
  code: z.string().nullish(),
  detail: z.string().nullish(),
  nextStep: z.string().nullish(),
  number: z.number(),
  reason: z.string().nullish(),
  state: z.record(z.string(), z.unknown()).nullish(),
});

const PR = z.number().nullish();

// The stage whose commits a stop pushes first, since only open-pr pushes
// them otherwise (#283).
const IMPLEMENT_STAGE = "implement";

// The stage after the merge, which a start resumes at (start-state.ts).
const PUBLISH_STAGE = "publish";

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
  const { stage } = req.state ?? {};
  if (stage === PUBLISH_STAGE) {
    return `To resume, fix what this names, then remove \`${control.label.name}\`. The PR has merged, so the next sweep publishes the wiki changes again, with every limit reset.`;
  }
  return `To resume, fix what this names (push to the branch if you like), then remove \`${control.label.name}\`. The next sweep continues from the PR's branch at review, with every limit reset.`;
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

function stop(cfg: Config, request: unknown): { code: string; label: string } {
  const req = STOP_REQUEST.parse(request);
  const n = req.number;
  const found = stopOf(req.code, req.reason);
  const { stage } = req.state ?? {};
  const state = {
    ...req.state,
    stage: "stopped",
    stoppedStage: stage ?? null,
    lease: null,
    stopCode: found.code,
    stopReason: req.reason,
  };
  const { pr } = req.state ?? {};
  const prNumber = PR.parse(pr) ?? 0;
  let unpushed: string[] = [];
  if (stage === IMPLEMENT_STAGE) {
    unpushed = pushUnpushed(cfg, n);
  }
  const body = stopComment(found, req, unpushed);
  comment(cfg, n, COORDINATOR, body);
  if (prNumber !== 0) {
    comment(cfg, prNumber, COORDINATOR, body);
  }
  writeState(cfg, n, state);
  for (const target of [n, prNumber].filter((number) => number !== 0)) {
    clearStopLabels(cfg, target);
    setLabels(cfg, target, [found.label.name], [LABELS.working.name]);
  }
  closeClaims(
    cfg,
    n,
    `the issue stopped (\`${found.label.name}\`); removing the label puts it back in the queue.`,
  );
  return { code: found.code, label: found.label.name };
}

export { stop };
