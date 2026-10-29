// The signal inbox: the one module other lanes import from src/signals/.
// pollSignals reads the control-label sensor, the reviews of each issue's
// linked PR and the accepted-signal records of the configured repository
// afresh, accepts newly qualified human label events and PR reviews as
// append-only records, and delivers qualified signals: accepted stops,
// pending accepted starts, accepted reviews that still stand and the task
// lane's authenticated machine results. requalify checks one delivered signal
// again before an action or privileged effect relies on it, and stopLatch
// reports an issue's persistent stop; requalifyHumanNow and stopLatchNow are
// their synchronous forms for ops mutation guards, with the same rules.
// Unknown evidence never throws and never reads as absence; it is reported as
// a hold.
import { z } from "zod";
import { rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { assertReconciled, confirmedWrite } from "../coordination-journal.ts";
import {
  type EvidenceHold,
  type HeadStartTask,
  isHeadStartTask,
  type PrReview,
  type QualifiedSignal,
  type SignalInbox,
  type StartTask,
  type TargetState,
  type WorkItemRef,
} from "../domain.ts";
import { readIssueExecution } from "../execution.ts";
import { historicalPrFor } from "../ops/prs.ts";
import {
  listReviews,
  type StandingReview,
  type SubmittedReview,
  standingOn,
} from "../pr-reviews.ts";
import { pullRequest } from "../revision.ts";
import { actionCauses, machineSignals, readTaskView } from "../tasks/index.ts";
import { errorText, unreadable } from "./github-source.ts";
import {
  CONTROL_LABELS,
  type ControlLabel,
  type LabelEvent,
  labelEvidence,
  labelledIssues,
  START_LABELS,
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
  reviewSignalId,
  sameAction,
  signalId,
  signalOf,
} from "./records.ts";

// The organization whose current members' label events and reviews
// qualify. It is configured explicitly, never derived from the repository's
// owner.
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
type TaskView = Awaited<ReturnType<typeof readTaskView>>;
type StartRequest = Extract<AcceptedRecord["request"], { kind: "start" }>;
type StartSignal = Extract<QualifiedSignal, { kind: "start" }>;
type ReviewSignal = Extract<QualifiedSignal, { kind: "review" }>;
type RequirementsTask = Exclude<StartTask, HeadStartTask>;

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
// The stop first, so a stop applied with a start makes it inert.
const ACCEPTANCE_ORDER: readonly ControlLabel[] = [
  STOP_LABEL,
  ...CONTROL_LABELS.filter((label) => label !== STOP_LABEL),
];
const BUDDY_RUN = z.uuid();

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

// Whether an attempt of the start's own task names it as its cause,
// whatever its binding or verdict.
function spends(
  attempts: readonly AttemptCause[],
  signal: StartSignal,
): boolean {
  return attempts.some(
    ({ binding, cause }) =>
      binding.task === signal.task && cause.signal === signal.id,
  );
}

async function causesOf(
  cfg: Config,
  number: number,
): Promise<Checked<readonly AttemptCause[]>> {
  try {
    return ok(await actionCauses(cfg, number));
  } catch (error) {
    return unread(`task attempts unreadable: ${errorText(error)}`);
  }
}

// The issue's linked PR: its own branch's PR, or null when it has none.
function linkedPr(cfg: Config, number: number): Checked<number | null> {
  try {
    return ok(historicalPrFor(cfg, number));
  } catch (error) {
    return unread(`#${number}'s linked PR unreadable: ${errorText(error)}`);
  }
}

// A fresh requirements start may request a retry; the task admits it only
// after the preceding attempt has settled failed.
function requirementsRequest(
  task: RequirementsTask,
  view: TaskView,
): Checked<StartRequest> {
  return ok({
    kind: "start",
    task,
    requirements: view.requirements,
    target: view.target,
  });
}

// The Verify, Fix or Land request for the current head of the issue's linked
// PR, or why none may be recorded: the issue has no PR, or it is no longer
// open.
function headRequest(
  cfg: Config,
  number: number,
  task: HeadStartTask,
  target: TargetState,
): Checked<StartRequest> {
  const verb = { verify: "verify", fix: "fix", land: "land" }[task];
  const linked = linkedPr(cfg, number);
  if (!linked.ok) {
    return linked;
  }
  const pr = linked.value;
  if (pr === null) {
    return refused(`#${number} has no linked PR to ${verb}`);
  }
  let pull: ReturnType<typeof pullRequest>;
  try {
    pull = pullRequest(cfg, number, pr);
  } catch (error) {
    return unread(`PR #${pr} unreadable: ${errorText(error)}`);
  }
  if (pull.state !== "OPEN") {
    return refused(`PR #${pr} is ${pull.state}, so it has no head to ${verb}`);
  }
  return ok({
    kind: "start",
    task,
    pr,
    head: pull.headSha,
    target,
  });
}

// The request a new start of `task` would record, read from the issue's
// task view now.
async function startRequest(
  cfg: Config,
  workItem: WorkItemRef,
  task: StartTask,
): Promise<Checked<StartRequest>> {
  let view: TaskView;
  try {
    view = await readTaskView(cfg, workItem.number);
  } catch (error) {
    return unread(`its task view is unreadable: ${errorText(error)}`);
  }
  if (view.hold !== null) {
    return refused(`its task view holds: ${view.hold}`);
  }
  if (isHeadStartTask(task)) {
    return headRequest(cfg, workItem.number, task, view.target);
  }
  return requirementsRequest(task, view);
}

// What the journal keeps of a record's source while its write is uncertain.
function sourceEvidence(record: AcceptedRecord): {
  signal: string;
  event?: number;
  review?: number;
} {
  const { source } = record;
  if (source.kind === "github-review") {
    return { signal: record.id, review: source.review.id };
  }
  return { signal: record.id, event: source.event.id };
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
      evidence: sourceEvidence(record),
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
  const task = START_LABELS.get(label);
  if (event.actor === null) {
    return refused("its event names no actor");
  }
  if (task !== undefined && rows.some(isStop)) {
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
  if (task !== undefined) {
    const start = await startRequest(cfg, workItem, task);
    if (!start.ok) {
      return start;
    }
    request = start.value;
  }
  const record = RECORD.safeParse({
    version: 2,
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
  await inOrder(ACCEPTANCE_ORDER, async (label) => {
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

// Each reviewer's standing approval or request for changes on the PR, on
// whichever head it binds.
function standingReviews(
  reviews: readonly SubmittedReview[],
): StandingReview[] {
  const heads = new Set(
    reviews.flatMap((review): string[] => {
      if (review.commit === null) {
        return [];
      }
      return [review.commit];
    }),
  );
  return [...heads].flatMap((head) => standingOn(reviews, head));
}

// Whether `review` is still its reviewer's standing review of its commit:
// not dismissed and not followed by a later approval or request for changes.
function stands(
  reviews: readonly SubmittedReview[],
  review: PrReview,
): boolean {
  return standingOn(reviews, review.commit).some(
    (item) => item.id === review.id && item.state === review.state,
  );
}

// Accepts one standing review by a qualified person. A review by a machine
// or by someone who isn't an active member grants nothing and holds
// nothing: anyone who can read the PR may review it.
function acceptReview(
  cfg: Config,
  context: PollContext,
  pr: number,
  review: StandingReview,
): Checked<AcceptedRow[] | null> {
  const { scope, buddyRun, poll } = context;
  const { workItem } = poll;
  const actor: EventActor = { ...review.author, viaApp: false };
  const qualification = qualifyActor(cfg, scope.organization, actor);
  if (qualification.status === "rejected") {
    return ok(null);
  }
  if (qualification.status === "unknown") {
    return unread(`its reviewer can't be qualified: ${qualification.reason}`);
  }
  const record = RECORD.safeParse({
    version: 2,
    kind: "accepted",
    id: reviewSignalId(workItem, review.id),
    workItem,
    source: {
      kind: "github-review",
      pr,
      review: { id: review.id, submittedAt: review.submittedAt },
    },
    producer: qualification.provenance,
    request: {
      kind: "review",
      review: { id: review.id, pr, commit: review.commit, state: review.state },
    },
    acceptedBy: { buddyRun },
  });
  if (!record.success) {
    return refused("its record would be invalid");
  }
  return append(cfg, workItem.number, record.data);
}

// Accepts each standing approval or request for changes on the issue's
// linked PR that a qualified person submitted and no record holds yet.
// Returns the issue's records after.
function acceptReviews(
  cfg: Config,
  context: PollContext,
  rows: AcceptedRow[],
): AcceptedRow[] {
  const { poll } = context;
  const linked = linkedPr(cfg, poll.workItem.number);
  if (!linked.ok) {
    holdFor(poll, "reviews unreadable", linked);
    return rows;
  }
  const pr = linked.value;
  if (pr === null) {
    return rows;
  }
  const listed = listReviews(cfg, pr);
  if (listed.status !== "ok") {
    unreadableOn(poll, `PR #${pr}'s reviews unreadable: ${unreadable(listed)}`);
    return rows;
  }
  let current = rows;
  for (const review of standingReviews(listed.value)) {
    const id = reviewSignalId(poll.workItem, review.id);
    if (!current.some((row) => row.record.id === id)) {
      const accepted = acceptReview(cfg, context, pr, review);
      if (!accepted.ok) {
        holdFor(
          poll,
          `review ${review.id} of PR #${pr} not accepted`,
          accepted,
        );
      } else if (accepted.value !== null) {
        current = accepted.value;
      }
    }
  }
  return current;
}

function deliverQualified(
  cfg: Config,
  scope: SignalScope,
  poll: IssuePoll,
  signal: StartSignal | ReviewSignal,
): void {
  const current = requalifyProducer(cfg, scope.organization, signal.provenance);
  if (current.status === "qualified") {
    poll.signals.push(signal);
  } else if (current.status === "unknown") {
    unreadableOn(
      poll,
      `accepted ${signal.kind} ${signal.id} held: ${current.reason}`,
    );
  } else {
    holdOn(
      poll,
      `accepted ${signal.kind} ${signal.id} revoked: ${current.reason}`,
    );
  }
}

// Delivers `start` when no action ran its binding yet, when it `recovers`
// its requirements' lost Implement run, or when it `continues` their
// interrupted one.
// Spent starts are delivered only to reconcile their own unsettled task.
function recovering(
  attempts: readonly AttemptCause[],
  signal: StartSignal,
): boolean {
  return attempts.some(
    ({ binding, unsettled }) =>
      binding.task === signal.task && unsettled === true,
  );
}

// Delivers each accepted start that is neither spent nor inert and whose
// producer still qualifies. A stop makes every pending start inert.
async function deliverStarts(
  cfg: Config,
  scope: SignalScope,
  poll: IssuePoll,
  rows: readonly AcceptedRow[],
): Promise<void> {
  const starts = rows
    .map(signalOf)
    .filter((signal): signal is StartSignal => signal.kind === "start");
  if (starts.length === 0 || rows.some(isStop)) {
    return;
  }
  const attempts = await causesOf(cfg, poll.workItem.number);
  if (!attempts.ok) {
    holdFor(poll, "accepted starts held", attempts);
    return;
  }
  for (const signal of starts) {
    if (!spends(attempts.value, signal) || recovering(attempts.value, signal)) {
      deliverQualified(cfg, scope, poll, signal);
    }
  }
}

// Delivers each accepted review that still stands on its PR and whose
// reviewer still qualifies; whether it binds the current head is the task
// lane's to decide. A stop makes every review inert.
function deliverReviews(
  cfg: Config,
  scope: SignalScope,
  poll: IssuePoll,
  rows: readonly AcceptedRow[],
): void {
  const reviews = rows
    .map(signalOf)
    .filter((signal): signal is ReviewSignal => signal.kind === "review");
  if (reviews.length === 0 || rows.some(isStop)) {
    return;
  }
  const listings = new Map<number, ReturnType<typeof listReviews>>();
  for (const signal of reviews) {
    const { pr } = signal.review;
    const listed = listings.get(pr) ?? listReviews(cfg, pr);
    listings.set(pr, listed);
    if (listed.status !== "ok") {
      unreadableOn(
        poll,
        `accepted review ${signal.id} held: PR #${pr}'s reviews unreadable: ${unreadable(listed)}`,
      );
    } else if (stands(listed.value, signal.review)) {
      deliverQualified(cfg, scope, poll, signal);
    }
  }
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
  if (held === null) {
    if (context.labelled) {
      rows = await acceptLabels(cfg, { ...context, poll }, rows);
    }
    // A stopped issue's reviews would be inert, so none is read or kept.
    if (!rows.some(isStop)) {
      rows = acceptReviews(cfg, { ...context, poll }, rows);
    }
  } else {
    holdOn(poll, `accepted signals held: ${held}`);
  }
  // A retained execution prevents new work, not acceptance/delivery of a
  // qualified stop. No ownership observation grants signal authority.
  const owned = held === null && rows.length > 0 && executionHeld(cfg, poll);
  for (const row of rows.filter(isStop)) {
    poll.signals.push(signalOf(row));
  }
  if (held === null && !owned) {
    await deliverStarts(cfg, context.scope, poll, rows);
    deliverReviews(cfg, context.scope, poll, rows);
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

// Why an accepted review no longer stands on its PR, or null while it does.
function reviewProblem(
  cfg: Config,
  signal: ReviewSignal,
): Requalification | null {
  const { pr } = signal.review;
  const listed = listReviews(cfg, pr);
  if (listed.status !== "ok") {
    return {
      status: "unknown",
      reason: `PR #${pr}'s reviews unreadable: ${unreadable(listed)}`,
    };
  }
  if (!stands(listed.value, signal.review)) {
    return {
      status: "revoked",
      reason: `review ${signal.review.id} of PR #${pr} no longer stands: it was dismissed or its reviewer reviewed again`,
    };
  }
  return null;
}

// Checks an accepted human signal again from its authenticated record,
// rereading it rather than trusting the caller's copy. `given`, when the
// caller holds a whole delivered signal, must be exactly what the record
// accepts. The retained producer must still be the same user and an active
// member; the label need not remain, but a review must still stand on its
// PR. A start or review on a stopped issue is revoked.
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
  if (accepted.kind !== "stop") {
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
  if (accepted.kind === "review") {
    const problem = reviewProblem(cfg, accepted);
    if (problem !== null) {
      return problem;
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
// record reread and qualification rules, for the accepted human signal,
// start, review or stop, that `source` names.
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
