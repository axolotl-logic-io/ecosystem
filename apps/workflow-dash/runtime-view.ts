// Views of the buddy runtime's observations. Every link shown is one the
// observation records (`previous`, `buddyRun`, loop `action`, session
// `parent`); the condition chips describe observations, never health or
// authority.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
  ActionRunEntry,
  BuddyRunEntry,
  RuntimeRuns,
} from "./runtime-runs.ts";
import { chip, type Ink, pad, shortRepo } from "./ui-format.ts";

const idWidth = 8;
const nameWidth = 16;
const conditionLabels: Record<string, { text: string; ink: Ink }> = {
  "process-observed": { text: "● PROCESS OBSERVED", ink: "syntaxFunction" },
  stale: { text: "! STALE", ink: "warning" },
  unknown: { text: "? UNKNOWN", ink: "warning" },
  unconfirmed: { text: "? UNCONFIRMED", ink: "warning" },
  "not observed": { text: "? NOT OBSERVED", ink: "warning" },
  stopped: { text: "■ STOPPED", ink: "muted" },
  ended: { text: "◷ ENDED", ink: "muted" },
};

function conditionChip(theme: Theme, state: string): string {
  const label = conditionLabels[state] ?? { text: state, ink: "warning" };
  return chip(theme, label.text, label.ink);
}
function short(id: string): string {
  return id.slice(0, idWidth);
}
function linked(id: string | null, observed: boolean): string {
  if (id === null) {
    return "none";
  }
  if (observed) {
    return id;
  }
  return `${id} (not observed)`;
}
/** ` (reason)`, or nothing when no reason is recorded. */
function noted(reason: string | null): string {
  if (reason === null) {
    return "";
  }
  return ` (${reason})`;
}
function stopText(stop: BuddyRunEntry["run"]["stop"]): string {
  if (stop === null) {
    return "none";
  }
  return `${stop.scope}: ${stop.reason} at ${stop.requestedAt}`;
}
function buddyOutcome(outcome: BuddyRunEntry["run"]["outcome"]): string {
  if (outcome === null) {
    return "none";
  }
  return `${outcome.kind}: ${outcome.reason} at ${outcome.at}`;
}
function bindingInputs(binding: ActionRunEntry["run"]["binding"]): string {
  if ("revision" in binding) {
    return `revision code ${binding.revision.code} · inputs ${binding.revision.inputs} · policy ${binding.revision.policy}`;
  }
  return `requirements ${binding.requirements}`;
}
function sessionLine(
  entry: ActionRunEntry,
  session: ActionRunEntry["run"]["sessions"][number],
): string {
  const link = entry.sessions.find((item) => item.id === session.id);
  let parent = `${session.parent} (another run)`;
  if (link?.parentMatches === true) {
    parent = "this action run";
  }
  const file = `${link?.fileState ?? "unknown"} ${link?.file ?? ""}`.trim();
  return `${session.id} · key ${session.key} · ${session.agent} ${session.model} · phase ${session.phase ?? "none"} · pid ${session.pid ?? "none"} · ${session.startedAt} → ${session.endedAt ?? "not ended"} · outcome ${session.outcome ?? "none"} · parent ${parent} · file ${file}`;
}

function buddyRunRow(entry: BuddyRunEntry, theme: Theme): string {
  const { run } = entry;
  const acting = run.loops.filter((loop) => loop.state === "acting").length;
  return `${pad(short(run.id), idWidth)} ${conditionChip(theme, entry.condition.state)} ${pad(run.buddy.name, nameWidth)} ${theme.fg("muted", `${run.buddy.role} · ${run.tasks.length} tasks · ${acting} acting · ${entry.actions.length} actions`)}`;
}
function buddyRunFacts(entry: BuddyRunEntry): string[] {
  const { run } = entry;
  const accounts = run.accounts.map(
    (account) => `${account.provider}:${account.login}`,
  );
  return [
    `Buddy run ${run.id}`,
    `Condition: ${entry.condition.state} · ${entry.condition.reason}`,
    `Recorded state: ${run.state} · outcome ${buddyOutcome(run.outcome)}`,
    `Buddy: ${run.buddy.name} · role ${run.buddy.role} · identity ${run.buddy.identity} · config ${run.buddy.config}`,
    `Recorded accounts: ${accounts.join(", ") || "none"} · observations, not authenticated identity or authority`,
    `Process: pid ${run.process.pid} on ${run.process.host} · started ${run.process.startedAt} · observed ${run.process.observedAt}`,
    `Lease: ${run.lease.seconds}s · expires ${run.lease.expiresAt}`,
    `Stop: ${stopText(run.stop)}`,
    `Previous buddy run: ${linked(run.previous, entry.previousObserved)}`,
    `Tasks: ${run.tasks.join(", ") || "none"}`,
    `Scope: ${run.scope.organization} · ${run.scope.repositories.map((repository) => `${repository.repo}@${repository.base}`).join(", ") || "no repositories"}`,
    `Caps: ${run.caps.map((cap) => `${cap.repo} model sessions ${cap.modelSessions}, test slots ${cap.testSlots ?? "none"}`).join("; ") || "none recorded"}`,
    "",
    "TASK LOOPS",
    ...run.loops.map(
      (loop) =>
        `${loop.task} on ${loop.repo}: ${loop.state}${noted(loop.reason)} · polled ${loop.polledAt ?? "never"} · action ${loop.action ?? "none"}`,
    ),
    "",
    `ACTION RUNS naming this buddy run: ${entry.actions.join(", ") || "none observed"}`,
    ...entry.warnings.map((warning) => `⚠ ${warning}`),
    "",
    `Source: ${entry.path}`,
  ];
}
function actionRunRow(entry: ActionRunEntry, theme: Theme): string {
  const { run } = entry;
  return `${pad(short(run.id), idWidth)} ${conditionChip(theme, entry.condition.state)} ${shortRepo(run.workItem.repo)} #${run.workItem.number} ${run.task} ${theme.fg("muted", `${run.state} · outcome ${run.outcome ?? "none"} · buddy run ${short(run.buddyRun)} ${entry.buddyRun.condition}`)}`;
}
function actionRunFacts(entry: ActionRunEntry): string[] {
  const { run } = entry;
  const target = `${run.binding.target.branch}@${run.binding.target.commit}`;
  let checkpointAt = "";
  if (run.checkpoint.at !== null) {
    checkpointAt = ` at ${run.checkpoint.at}`;
  }
  return [
    `Action run ${run.id}`,
    `Condition: ${entry.condition.state} · ${entry.condition.reason}`,
    `Recorded state: ${run.state} · outcome ${run.outcome ?? "none"} · verdict ${run.verdict ?? "none"} · reason ${run.reason ?? "none"}`,
    `Buddy run: ${entry.buddyRun.id} · ${entry.buddyRun.condition} · ${entry.buddyRun.reason}`,
    `Previous action run: ${linked(run.previous, entry.previousObserved)}`,
    `Task ${run.task} · ${run.workItem.repo}#${run.workItem.number} · mode ${run.mode}`,
    `Binding target ${target} · ${bindingInputs(run.binding)}`,
    `Cause: signal ${run.cause.signal} · record ${run.cause.recordId}`,
    `Execution: lane ${run.execution.lane} · instance ${run.execution.instance} · branch ${run.execution.branch} on ${run.execution.repo}/${run.execution.base}`,
    `Authorization digest: ${run.authorization}`,
    `Checkpoint: ${run.checkpoint.state}${checkpointAt}${noted(run.checkpoint.reason)}`,
    `Issue execution: ${run.ownership.state}${noted(run.ownership.reason)}`,
    `Stop: ${stopText(run.stop)}`,
    "",
    "SESSIONS (parent → this action run)",
    ...run.sessions.map((session) => sessionLine(entry, session)),
    "",
    "OPERATIONS",
    ...run.operations.map(
      (operation) =>
        `${operation.key} · ${operation.op} · pid ${operation.pid ?? "none"} · ${operation.startedAt} → ${operation.endedAt ?? "not ended"} · outcome ${operation.outcome ?? "none"}`,
    ),
    "",
    "RESERVATIONS",
    ...run.reservations.map(
      (reservation) =>
        `${reservation.resource} slot ${reservation.slot} · ${reservation.state}${noted(reservation.reason)}`,
    ),
    `Preserved: checkout ${run.preserved.checkout ?? "none"} · patches ${run.preserved.patches.join(", ") || "none"}`,
    ...entry.warnings.map((warning) => `⚠ ${warning}`),
    "",
    `Source: ${entry.path}`,
  ];
}
function coverageFacts(runtime: RuntimeRuns): string[] {
  const { coverage, problems } = runtime;
  return [
    "Coverage of buddy-run and action-run observations",
    coverage.note,
    `Root: ${coverage.root || "not collected"} · repositories ${coverage.repositories.join(", ") || "none"}`,
    `Omitted by read bounds: ${coverage.buddyRunsOmitted} buddy runs · ${coverage.actionRunsOmitted} action runs`,
    ...coverage.unlistable.map((path) => `Unlistable: ${path}`),
    "",
    `UNREADABLE OBSERVATIONS · ${problems.length}`,
    ...problems.map(
      (problem) => `${problem.kind} ${problem.path}: ${problem.reason}`,
    ),
  ];
}
function partialCoverage(runtime: RuntimeRuns): boolean {
  const { coverage } = runtime;
  return (
    runtime.problems.length > 0 ||
    coverage.unlistable.length > 0 ||
    coverage.buddyRunsOmitted > 0 ||
    coverage.actionRunsOmitted > 0
  );
}
function coverageRow(runtime: RuntimeRuns, theme: Theme): string {
  if (partialCoverage(runtime)) {
    return theme.fg(
      "warning",
      `⚠ Coverage partial · ${runtime.problems.length} unreadable · ${runtime.coverage.buddyRunsOmitted + runtime.coverage.actionRunsOmitted} omitted`,
    );
  }
  return theme.fg("muted", "◷ Coverage · bounded local observations");
}
function factLines(facts: string[], theme: Theme, width: number): string[] {
  const [title, ...rest] = facts;
  return [
    theme.fg("accent", title ?? ""),
    ...rest.flatMap((line) => {
      if (line.startsWith("⚠")) {
        return wrapTextWithAnsi(line, width).map((part) =>
          theme.fg("warning", part),
        );
      }
      if (line === line.toUpperCase() && line.trim() !== "") {
        return [theme.fg("borderAccent", line)];
      }
      return wrapTextWithAnsi(line, width);
    }),
  ];
}

export {
  actionRunFacts,
  actionRunRow,
  buddyRunFacts,
  buddyRunRow,
  coverageFacts,
  coverageRow,
  factLines,
  partialCoverage,
};
