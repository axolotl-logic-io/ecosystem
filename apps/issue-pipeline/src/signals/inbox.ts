// The signal inbox: the one module other lanes import from src/signals/.
// pollSignals reads the control-label sensor and the accepted-signal
// records of the configured repository afresh, accepts newly qualified human
// label events as append-only records, and delivers qualified signals:
// accepted stops, pending accepted starts and the task lane's authenticated
// machine results. requalify checks one delivered signal again before an
// action or privileged effect relies on it, and stopLatch reports an issue's
// persistent stop; requalifyHumanNow and stopLatchNow are their synchronous
// forms for ops mutation guards, with the same rules. Unknown evidence never throws and never reads as absence;
// it is reported as a hold (`signal-authority`, `label-signals`).
import { z } from "zod";
import { rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { assertReconciled, confirmedWrite } from "../coordination-journal.ts";
import type {
  Binding,
  EvidenceHold,
  QualifiedSignal,
  SignalInbox,
  WorkItemRef,
} from "../domain.ts";
import { readIssueExecution } from "../execution.ts";
import {
  actionCauses,
  machineSignals,
  previousAction,
  readTaskView,
} from "../tasks/index.ts";
import { errorText, unreadable } from "./github-source.ts";
import {
  CONTROL_LABELS,
  type ControlLabel,
  type LabelEvent,
  labelEvidence,
  labelledIssues,
} from "./label-evidence.ts";
import {
  type EventActor,
  GITHUB_LOGIN,
  machineReason,
  qualifyActor,
  requalifyProducer,
} from "./qualification.ts";
import {
  type AcceptedRecord,
  type AcceptedRow,
  canonical,
  issueRecords,
  markedIssues,
  RECORD,
  recordBody,
  sameAction,
  signalId,
  signalOf,
} from "./records.ts";

// The organization whose current members' label events qualify. It is
// configured explicitly, never derived from the repository's owner.
interface SignalScope {
  organization: string;
}

interface Requalification {
  status: "qualified" | "revoked" | "unknown";
  reason: string;
}

// What names an accepted human signal to the synchronous guard: its id,
// the record that accepted it and its work item.
interface HumanSource {
  id: string;
  recordId: number;
  workItem: WorkItemRef;
}

interface Latch {
  state: "clear" | "latched" | "unknown";
  reason: string;
}

type AttemptCause = Awaited<ReturnType<typeof actionCauses>>[number];
type StartRequest = Extract<AcceptedRecord["request"], { kind: "start" }>;
type StartSignal = Extract<
  QualifiedSignal,
  { kind: "start"; task: "author" | "implement" }
>;

// A value, or why it isn't available: `unreadable` when evidence couldn't be
// read, rather than read and found wanting.
type Checked<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; unreadable: boolean };

// One issue's evaluation within a poll. `complete` turns false when some
// evidence about the issue couldn't be read.
interface IssuePoll {
  workItem: WorkItemRef;
  signals: QualifiedSignal[];
  holds: EvidenceHold[];
  complete: boolean;
}

interface PollContext {
  scope: SignalScope;
  buddyRun: string;
  poll: IssuePoll;
}

interface Candidate {
  label: ControlLabel;
  event: LabelEvent;
}

const STOP_LABEL: ControlLabel = "agents:stop";
const START_LABEL: ControlLabel = "start:implement";
const BUDDY_RUN = z.uuid();
const UNSUPPORTED_RETRY =
  "retrying requirements Implement already attempted is unsupported; change the requirements to request new work";

// Runs `step` on each of `items` in order, each after the one before it
// settles: an issue's evidence is read, and its records appended, one at a
// time.
async function inOrder<T>(
  items: readonly T[],
  step: (item: T) => Promise<void>,
): Promise<void> {
  await items.reduce(async (prior: Promise<void>, item: T): Promise<void> => {
    await prior;
    await step(item);
  }, Promise.resolve());
}

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function refused<T>(reason: string): Checked<T> {
  return { ok: false, reason, unreadable: false };
}

function unread<T>(reason: string): Checked<T> {
  return { ok: false, reason, unreadable: true };
}

function scopeProblem(scope: SignalScope): string | null {
  if (!GITHUB_LOGIN.test(scope.organization)) {
    return `signal scope organization ${JSON.stringify(scope.organization)} is not a GitHub organization name`;
  }
  return null;
}

function holdOn(poll: IssuePoll, reason: string): void {
  poll.holds.push({ workItem: poll.workItem, reason });
}

function unreadableOn(poll: IssuePoll, reason: string): void {
  holdOn(poll, reason);
  poll.complete = false;
}

function holdFor(
  poll: IssuePoll,
  prefix: string,
  failure: Extract<Checked<unknown>, { ok: false }>,
): void {
  if (failure.unreadable) {
    unreadableOn(poll, `${prefix}: ${failure.reason}`);
  } else {
    holdOn(poll, `${prefix}: ${failure.reason}`);
  }
}

// Why an uncertain write retained on the issue holds it, or null.
function journalProblem(cfg: Config, number: number): string | null {
  try {
    assertReconciled(cfg, number);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

// Ownership outlives a process or spent start. Observe it independently of
// pending signals so an uncertain checkpoint cannot disappear as idle work.
function executionHeld(cfg: Config, poll: IssuePoll): boolean {
  try {
    const view = readIssueExecution(cfg, poll.workItem.number);
    if (view.owner !== null) {
      holdOn(
        poll,
        `issue execution remains owned by ${view.owner.binding.instance}; settlement and explicit release are required`,
      );
      return true;
    }
    if (view.pending.length > 0) {
      holdOn(poll, "issue execution has unresolved ownership requests");
      return true;
    }
    return false;
  } catch (error) {
    unreadableOn(poll, `issue execution unreadable: ${errorText(error)}`);
    return true;
  }
}

function isStop(row: AcceptedRow): boolean {
  return row.record.request.kind === "stop";
}

function stopNames(rows: readonly AcceptedRow[]): string {
  return rows
    .filter(isStop)
    .map((row) => `${row.record.id} (record ${row.recordId})`)
    .join(", ");
}

// The Implement attempt that already tried `requirements`, if any. The work
// item and requirements are the retry boundary, whatever the target.
function attemptedRequirements(
  attempts: readonly AttemptCause[],
  requirements: string,
): AttemptCause | undefined {
  return attempts.find(
    ({ binding }) =>
      binding.task === "implement" &&
      "requirements" in binding &&
      binding.requirements === requirements,
  );
}

// Whether an Implement attempt names start `id` as its cause, whatever its
// binding or verdict.
function spends(attempts: readonly AttemptCause[], id: string): boolean {
  return attempts.some(
    ({ binding, cause }) => binding.task === "implement" && cause.signal === id,
  );
}

async function causesOf(
  cfg: Config,
  number: number,
): Promise<Checked<readonly AttemptCause[]>> {
  try {
    return ok(await actionCauses(cfg, number));
  } catch (error) {
    return unread(`Implement attempts unreadable: ${errorText(error)}`);
  }
}

async function previousOf(
  cfg: Config,
  binding: Binding,
): Promise<Checked<string | null>> {
  try {
    return ok(await previousAction(cfg, binding));
  } catch (error) {
    return unread(`previous Implement action unreadable: ${errorText(error)}`);
  }
}

// The requirements binding a new start would request, or why none may be
// recorded. A start never re-requests requirements Implement has attempted:
// retry coverage is undecided, so that is a hold, not permission.
async function startRequest(
  cfg: Config,
  workItem: WorkItemRef,
  attempts: readonly AttemptCause[],
): Promise<Checked<StartRequest>> {
  let view: Awaited<ReturnType<typeof readTaskView>>;
  try {
    view = await readTaskView(cfg, workItem.number);
  } catch (error) {
    return unread(`its task view is unreadable: ${errorText(error)}`);
  }
  if (view.hold !== null) {
    return refused(`its task view holds: ${view.hold}`);
  }
  const prior = attemptedRequirements(attempts, view.requirements);
  if (prior !== undefined) {
    return refused(
      `Implement already attempted these requirements under cause ${prior.cause.signal}; ${UNSUPPORTED_RETRY}`,
    );
  }
  const previous = await previousOf(cfg, {
    workItem,
    task: "implement",
    target: view.target,
    requirements: view.requirements,
  });
  if (!previous.ok) {
    return previous;
  }
  if (previous.value !== null) {
    return refused(
      `Implement action ${previous.value} already ran for this binding; ${UNSUPPORTED_RETRY}`,
    );
  }
  return ok({
    kind: "start",
    task: "implement",
    requirements: view.requirements,
    target: view.target,
  });
}

// Appends `record` once through the uncertain-write journal and confirms it
// by a fresh authenticated read. A lost acknowledgement the read can't
// confirm leaves the journal retained, which holds the issue; nothing posts
// again.
function append(
  cfg: Config,
  number: number,
  record: AcceptedRecord,
): Checked<AcceptedRow[]> {
  const seen: { rows: AcceptedRow[] | null } = { rows: null };
  try {
    confirmedWrite(cfg, number, "accept-signal", {
      // `reconciles`: this journal and read-back reconcile the write.
      write: (): void => rawComment(cfg, number, recordBody(record), true),
      confirmed: (): boolean => {
        const reread = issueRecords(cfg, number);
        if (
          reread.status === "ok" &&
          reread.problem === null &&
          reread.rows.some((row) => sameAction(row.record, record))
        ) {
          seen.rows = reread.rows;
          return true;
        }
        return false;
      },
      evidence: { signal: record.id, event: record.source.event.id },
    });
  } catch (error) {
    return unread(
      `acceptance of ${record.id} is uncertain: ${errorText(error)}`,
    );
  }
  if (seen.rows === null) {
    return unread(`acceptance of ${record.id} was not confirmed`);
  }
  return ok(seen.rows);
}

// Accepts one label event, or returns why it grants nothing yet.
async function accept(
  cfg: Config,
  context: PollContext,
  rows: readonly AcceptedRow[],
  candidate: Candidate,
): Promise<Checked<AcceptedRow[]>> {
  const { scope, buddyRun, poll } = context;
  const { workItem } = poll;
  const { label, event } = candidate;
  if (event.actor === null) {
    return refused("its event names no actor");
  }
  if (label === START_LABEL && rows.some(isStop)) {
    return refused(
      `#${workItem.number} is stopped by accepted stop ${stopNames(rows)}; removing agents:stop does not continue work`,
    );
  }
  const qualification = qualifyActor(cfg, scope.organization, event.actor);
  if (qualification.status === "rejected") {
    return refused(`it grants nothing: ${qualification.reason}`);
  }
  if (qualification.status === "unknown") {
    return unread(`its producer can't be qualified: ${qualification.reason}`);
  }
  let request: AcceptedRecord["request"] = { kind: "stop" };
  if (label === START_LABEL) {
    const attempts = await causesOf(cfg, workItem.number);
    if (!attempts.ok) {
      return attempts;
    }
    const start = await startRequest(cfg, workItem, attempts.value);
    if (!start.ok) {
      return start;
    }
    request = start.value;
  }
  const record = RECORD.safeParse({
    version: 1,
    kind: "accepted",
    id: signalId(workItem, event.id),
    workItem,
    source: {
      kind: "github-label",
      label,
      event: { id: event.id, nodeId: event.nodeId, createdAt: event.createdAt },
    },
    producer: qualification.provenance,
    request,
    acceptedBy: { buddyRun },
  });
  if (!record.success) {
    return refused("its record would be invalid");
  }
  return append(cfg, workItem.number, record.data);
}

// Accepts each control label the issue carries now whose explaining event
// isn't recorded yet, the stop first. Returns the issue's records after.
async function acceptLabels(
  cfg: Config,
  context: PollContext,
  rows: AcceptedRow[],
): Promise<AcceptedRow[]> {
  const { poll } = context;
  const evidence = labelEvidence(cfg, poll.workItem.number);
  if (evidence.status !== "ok") {
    unreadableOn(poll, `control labels unreadable: ${unreadable(evidence)}`);
    return rows;
  }
  let current = rows;
  await inOrder([STOP_LABEL, START_LABEL], async (label) => {
    const event = evidence.value.get(label);
    if (event === null) {
      holdOn(
        poll,
        `${label} is present but its latest label event does not explain it`,
      );
    } else if (
      event !== undefined &&
      !current.some(
        (row) => row.record.id === signalId(poll.workItem, event.id),
      )
    ) {
      const accepted = await accept(cfg, context, current, { label, event });
      if (accepted.ok) {
        current = accepted.value;
      } else {
        holdFor(poll, `${label} event ${event.id} not accepted`, accepted);
      }
    }
  });
  return current;
}

async function deliverStart(
  cfg: Config,
  scope: SignalScope,
  poll: IssuePoll,
  signal: StartSignal,
): Promise<void> {
  const previous = await previousOf(cfg, {
    workItem: signal.workItem,
    task: "implement",
    target: signal.target,
    requirements: signal.requirements,
  });
  if (!previous.ok) {
    holdFor(poll, `accepted start ${signal.id} held`, previous);
    return;
  }
  if (previous.value !== null) {
    return;
  }
  const current = requalifyProducer(cfg, scope.organization, signal.provenance);
  if (current.status === "qualified") {
    poll.signals.push(signal);
  } else if (current.status === "unknown") {
    unreadableOn(poll, `accepted start ${signal.id} held: ${current.reason}`);
  } else {
    holdOn(poll, `accepted start ${signal.id} revoked: ${current.reason}`);
  }
}

// Delivers each accepted start that is neither spent nor inert and whose
// producer still qualifies. A stop makes every pending start inert.
async function deliverStarts(
  cfg: Config,
  scope: SignalScope,
  poll: IssuePoll,
  rows: readonly AcceptedRow[],
): Promise<void> {
  const starts = rows.filter((row) => !isStop(row)).map(signalOf);
  if (starts.length === 0 || rows.some(isStop)) {
    return;
  }
  const attempts = await causesOf(cfg, poll.workItem.number);
  if (!attempts.ok) {
    holdFor(poll, "accepted starts held", attempts);
    return;
  }
  const pending = starts.filter(
    (signal): signal is StartSignal =>
      signal.kind === "start" &&
      signal.task !== "verify" &&
      !spends(attempts.value, signal.id) &&
      attemptedRequirements(attempts.value, signal.requirements) === undefined,
  );
  await inOrder(pending, (signal) => deliverStart(cfg, scope, poll, signal));
}

async function deliverResults(cfg: Config, poll: IssuePoll): Promise<void> {
  let results: Awaited<ReturnType<typeof machineSignals>>;
  try {
    results = await machineSignals(cfg, poll.workItem.number);
  } catch (error) {
    unreadableOn(poll, `machine results unreadable: ${errorText(error)}`);
    return;
  }
  for (const result of results) {
    if (
      result.kind === "result" &&
      result.workItem.repo === poll.workItem.repo &&
      result.workItem.number === poll.workItem.number
    ) {
      poll.signals.push(result);
    } else {
      holdOn(poll, `machine signal ${result.id} is not a result of this issue`);
    }
  }
}

async function pollIssue(
  cfg: Config,
  context: { scope: SignalScope; buddyRun: string; labelled: boolean },
  number: number,
): Promise<IssuePoll> {
  const poll: IssuePoll = {
    workItem: { repo: cfg.repo, number },
    signals: [],
    holds: [],
    complete: true,
  };
  const records = issueRecords(cfg, number);
  if (records.status === "unknown") {
    unreadableOn(poll, `accepted signals unreadable: ${records.reason}`);
    return poll;
  }
  const held = records.problem ?? journalProblem(cfg, number);
  let { rows } = records;
  if (held !== null) {
    holdOn(poll, `accepted signals held: ${held}`);
  } else if (context.labelled) {
    rows = await acceptLabels(cfg, { ...context, poll }, rows);
  }
  // A retained execution prevents new work, not acceptance/delivery of a
  // qualified stop. No ownership observation grants signal authority.
  const owned = held === null && rows.length > 0 && executionHeld(cfg, poll);
  for (const row of rows.filter(isStop)) {
    poll.signals.push(signalOf(row));
  }
  if (held === null && !owned) {
    await deliverStarts(cfg, context.scope, poll, rows);
  }
  if (rows.length > 0) {
    await deliverResults(cfg, poll);
  }
  return poll;
}

// Polls the configured repository: every page of the open issues carrying
// each control label, and every page of the repository's comments to find
// the issues holding accepted records whatever their labels now. `complete`
// is false when any evidence couldn't be read.
async function pollSignals(
  cfg: Config,
  scope: SignalScope,
  buddyRun: string,
): Promise<SignalInbox> {
  let invalid = scopeProblem(scope);
  if (!BUDDY_RUN.safeParse(buddyRun).success) {
    invalid ??= `buddy run ${JSON.stringify(buddyRun)} is not a UUID`;
  }
  if (invalid !== null) {
    return {
      signals: [],
      holds: [{ workItem: null, reason: invalid }],
      complete: false,
    };
  }
  const holds: EvidenceHold[] = [];
  const labelled = new Set<number>();
  for (const label of CONTROL_LABELS) {
    const listed = labelledIssues(cfg, label);
    if (listed.status === "ok") {
      for (const number of listed.value) {
        labelled.add(number);
      }
    } else {
      holds.push({
        workItem: null,
        reason: `open issues labelled ${label} unreadable: ${unreadable(listed)}`,
      });
    }
  }
  const marked = markedIssues(cfg);
  const numbers = new Set(labelled);
  if (marked.status === "ok") {
    for (const number of marked.value) {
      numbers.add(number);
    }
  } else {
    holds.push({
      workItem: null,
      reason: `accepted-signal discovery unreadable: ${unreadable(marked)}`,
    });
  }
  let complete = holds.length === 0;
  const signals: QualifiedSignal[] = [];
  await inOrder(
    [...numbers].sort((a, b) => a - b),
    async (number) => {
      const poll = await pollIssue(
        cfg,
        { scope, buddyRun, labelled: labelled.has(number) },
        number,
      );
      signals.push(...poll.signals);
      holds.push(...poll.holds);
      complete &&= poll.complete;
    },
  );
  return { signals, holds, complete };
}

async function requalifyResult(
  cfg: Config,
  signal: Extract<QualifiedSignal, { kind: "result" }>,
): Promise<Requalification> {
  let results: Awaited<ReturnType<typeof machineSignals>>;
  try {
    results = await machineSignals(cfg, signal.workItem.number);
  } catch (error) {
    return {
      status: "unknown",
      reason: `machine results unreadable: ${errorText(error)}`,
    };
  }
  if (results.some((result) => canonical(result) === canonical(signal))) {
    return {
      status: "qualified",
      reason: `result record ${signal.recordId} is current`,
    };
  }
  return {
    status: "revoked",
    reason: `result record ${signal.recordId} is no longer an authenticated current result`,
  };
}

// Checks an accepted human signal again from its authenticated record,
// rereading it rather than trusting the caller's copy. `given`, when the
// caller holds a whole delivered signal, must be exactly what the record
// accepts. The retained producer must still be the same user and an active
// member; the label need not remain. A start on a stopped issue is revoked.
function requalifyAccepted(
  cfg: Config,
  scope: SignalScope,
  source: HumanSource,
  given: QualifiedSignal | null,
): Requalification {
  const invalid = scopeProblem(scope);
  if (invalid !== null) {
    return { status: "unknown", reason: invalid };
  }
  if (source.workItem.repo !== cfg.repo) {
    return {
      status: "revoked",
      reason: `${source.id} belongs to another repository`,
    };
  }
  const { number } = source.workItem;
  const records = issueRecords(cfg, number);
  if (records.status === "unknown") {
    return {
      status: "unknown",
      reason: `accepted signals unreadable: ${records.reason}`,
    };
  }
  const row = records.rows.find((item) => item.recordId === source.recordId);
  if (row === undefined) {
    return {
      status: "unknown",
      reason:
        records.problem ??
        `record ${source.recordId} of ${source.id} is no longer an authentic accepted record`,
    };
  }
  const accepted = signalOf(row);
  if (
    accepted.id !== source.id ||
    (given !== null && canonical(accepted) !== canonical(given))
  ) {
    return {
      status: "unknown",
      reason: `record ${source.recordId} does not accept ${source.id} as given`,
    };
  }
  if (accepted.kind === "start") {
    if (records.rows.some(isStop)) {
      return {
        status: "revoked",
        reason: `#${number} is stopped by accepted stop ${stopNames(records.rows)}`,
      };
    }
    const held = records.problem ?? journalProblem(cfg, number);
    if (held !== null) {
      return { status: "unknown", reason: held };
    }
  }
  const { producer: provenance } = row.record;
  const current = requalifyProducer(cfg, scope.organization, provenance);
  if (current.status === "qualified") {
    return {
      status: "qualified",
      reason: `@${current.provenance.login} (user ${provenance.userId}) is an active member of ${scope.organization}`,
    };
  }
  if (current.status === "rejected") {
    return { status: "revoked", reason: current.reason };
  }
  return { status: "unknown", reason: current.reason };
}

// Checks a delivered signal again, fresh, immediately before an action or a
// privileged effect relies on it. Result signals must still be among the
// task lane's authenticated current results. Spending is not rechecked
// here: the task lane's beginAction records the attempt that spends a start.
async function requalify(
  cfg: Config,
  scope: SignalScope,
  signal: QualifiedSignal,
): Promise<Requalification> {
  if (signal.kind === "result") {
    return await requalifyResult(cfg, signal);
  }
  return requalifyAccepted(cfg, scope, signal, signal);
}

// The synchronous form of requalify for ops mutation guards: the same
// record reread and qualification rules, for the accepted human signal
// `source` names.
function requalifyHumanNow(
  cfg: Config,
  scope: SignalScope,
  source: HumanSource,
): Requalification {
  return requalifyAccepted(cfg, scope, source, null);
}

// The latch an unaccepted agents:stop label implies. Only a producer that
// affirmatively can't qualify without any read, a machine, clears it; a
// person's label stays unknown until a poll qualifies and accepts it, since
// stopLatch has no organization to qualify them against.
function unacceptedStop(
  cfg: Config,
  event: LabelEvent & { actor: EventActor },
): Latch {
  const machine = machineReason(cfg, event.actor);
  if (machine !== null) {
    return {
      state: "clear",
      reason: `agents:stop event ${event.id} grants nothing: ${machine}`,
    };
  }
  return {
    state: "unknown",
    reason: `agents:stop event ${event.id} by @${event.actor.login} is not accepted yet`,
  };
}

// The synchronous form of stopLatch, for ops mutation guards.
function stopLatchNow(cfg: Config, number: number): Latch {
  const records = issueRecords(cfg, number);
  if (records.status === "unknown") {
    return {
      state: "unknown",
      reason: `accepted signals unreadable: ${records.reason}`,
    };
  }
  if (records.rows.some(isStop)) {
    return {
      state: "latched",
      reason: `accepted stop ${stopNames(records.rows)}`,
    };
  }
  const held = records.problem ?? journalProblem(cfg, number);
  if (held !== null) {
    return { state: "unknown", reason: held };
  }
  const evidence = labelEvidence(cfg, number);
  if (evidence.status !== "ok") {
    return {
      state: "unknown",
      reason: `control labels unreadable: ${unreadable(evidence)}`,
    };
  }
  const event = evidence.value.get(STOP_LABEL);
  if (event === undefined) {
    return {
      state: "clear",
      reason: "no accepted stop and no agents:stop label",
    };
  }
  if (event === null) {
    return {
      state: "unknown",
      reason:
        "agents:stop is present but its latest label event does not explain it",
    };
  }
  const { actor } = event;
  if (actor === null) {
    return {
      state: "unknown",
      reason: `agents:stop event ${event.id} names no actor`,
    };
  }
  return unacceptedStop(cfg, { ...event, actor });
}

// Whether issue `number` is stopped. Any accepted stop latches it across
// buddy runs, whatever its label now; removing agents:stop never clears it.
// An agents:stop label not yet accepted is unknown unless a machine applied
// it, which grants nothing.
function stopLatch(cfg: Config, number: number): Promise<Latch> {
  return Promise.resolve(stopLatchNow(cfg, number));
}

export type { SignalScope };
export { pollSignals, requalify, requalifyHumanNow, stopLatch, stopLatchNow };
