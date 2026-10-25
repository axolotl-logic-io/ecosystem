// Validated append-only history. A missing/changed immutable epoch lock or a
// conflicting record never falls back to an older, more permissive owner.
// Three kinds of scope exist: an issue's execution, a target's integration
// turn, and one slot of a shared resource. A resource slot's records are
// version 3 and only they are; its owner's consumers must all report done
// before a release counts.
import { z } from "zod";
import { assertCommentAuthority } from "./comment-authority.ts";
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import {
  type CONSUMER,
  currentRecord,
  type INVOCATION_BINDING,
  RECORD,
  RESOURCE_RECORD_VERSION,
} from "./coordination-record-schema.ts";
import { OpsError } from "./ops-error.ts";

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const HEADER = "<!-- agent-pipeline:coordination\n";
const END = "\n-->";
const EVIDENCE = z.json();
type Evidence = z.infer<typeof EVIDENCE>;
type InvocationBinding = z.infer<typeof INVOCATION_BINDING>;
type Record = z.infer<typeof RECORD>;
type Row = Record & { id: number };
type Request = Extract<Row, { kind: "request" }>;
// The version new records in a scope are written in.
type RecordVersion = 2 | typeof RESOURCE_RECORD_VERSION;
type Consumer = z.infer<typeof CONSUMER>;
// A consumer the slot's owner registered, and whether it reported done.
interface ConsumerState {
  consumer: Consumer;
  done: boolean;
}
// The resources whose capacity is a set of shared slot scopes. Test slots
// are machine-local (lane-slots.ts) and target writes are the integration
// turn, so neither is one.
const SHARED_RESOURCE = z.enum(["model-session"]);
type SharedResource = z.infer<typeof SHARED_RESOURCE>;
const RESOURCE_SCOPE = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.literal("resource"),
  SHARED_RESOURCE,
  z.number().int().positive(),
]);
interface ResourceSlot {
  repo: string;
  base: string;
  resource: SharedResource;
  slot: number;
}
interface CoordinationPort {
  comments: () => readonly IssueComment[];
  append: (body: string) => void;
  token: (identity: InvocationBinding) => string;
  lock: (ref: string) => string | null;
  reserve: (ref: string, token: string) => void;
  write: (
    operation: string,
    write: () => void,
    confirmed: () => boolean,
    evidence?: Evidence,
  ) => void;
}
interface Snapshot {
  owner: Request | null;
  confirmed: boolean;
  pending: Request[];
  epoch: number;
  records: Row[];
  // The current owner's consumers, in registration order.
  consumers: ConsumerState[];
}
function hold(reason: string): never {
  throw new OpsError(`coordination requires reconciliation: ${reason}`);
}
function bodyOf(record: Record): string {
  return `${HEADER}${JSON.stringify(RECORD.parse(record))}${END}`;
}
function scopeOf(id: InvocationBinding, kind: "issue" | "integration"): string {
  if (kind === "issue") {
    return JSON.stringify([id.repo, id.base, kind, id.issue, id.branch]);
  }
  return JSON.stringify([id.repo, id.base, kind]);
}
// Slot `slot` of `resource` on a repository and base.
function resourceScopeOf(
  at: Pick<InvocationBinding, "repo" | "base">,
  resource: SharedResource,
  slot: number,
): string {
  return JSON.stringify([at.repo, at.base, "resource", resource, slot]);
}
// The resource slot `scope` names, or null when it names none exactly.
function resourceOf(scope: string): ResourceSlot | null {
  let raw: unknown = null;
  try {
    raw = JSON.parse(scope);
  } catch {
    return null;
  }
  const parsed = RESOURCE_SCOPE.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const [repo, base, , resource, slot] = parsed.data;
  if (resourceScopeOf({ repo, base }, resource, slot) !== scope) {
    return null;
  }
  return { repo, base, resource, slot };
}
// The version a new record in `scope` is written in.
function recordVersion(scope: string): RecordVersion {
  if (resourceOf(scope) === null) {
    return 2;
  }
  return RESOURCE_RECORD_VERSION;
}
function assertScope(scope: string, identity: InvocationBinding): void {
  const slot = resourceOf(scope);
  if (
    scope !== scopeOf(identity, "issue") &&
    scope !== scopeOf(identity, "integration") &&
    (slot === null ||
      slot.repo !== identity.repo ||
      slot.base !== identity.base)
  ) {
    hold("request identity does not match coordination scope");
  }
}
function refOf(scope: string, epoch: number): string {
  const key = Array.from(
    new TextEncoder().encode(scope),
    (byte: number): string =>
      byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
  return `heads/pipeline-coordination/${key}/${epoch}`;
}
function parseRecord(cfg: Config, comment: IssueComment): Row[] {
  const body = comment.body ?? "";
  if (!body.includes("agent-pipeline:coordination")) {
    return [];
  }
  assertCommentAuthority(cfg, comment);
  if (!(body.startsWith(HEADER) && body.endsWith(END))) {
    hold("malformed record");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(HEADER.length, -END.length));
  } catch {
    hold("unreadable record");
  }
  const record = currentRecord(raw);
  if (record === null) {
    hold("invalid record");
  }
  if (
    (record.version === RESOURCE_RECORD_VERSION) !==
    (resourceOf(record.scope) !== null)
  ) {
    hold("record version does not match its scope");
  }
  if (record.kind === "request") {
    assertScope(record.scope, record.binding);
  }
  return [{ ...record, id: comment.id }];
}
function recordsOf(
  cfg: Config,
  comments: readonly IssueComment[],
  scope: string,
): Row[] {
  const history = comments.flatMap((comment) => parseRecord(cfg, comment));
  // Validate linkage before scope selection: a moved transition must not vanish.
  for (const row of history.filter((item) => item.kind !== "request")) {
    const request = history.find(
      (item): item is Request =>
        item.kind === "request" && item.id === row.request,
    );
    if (
      request === undefined ||
      row.scope !== request.scope ||
      row.instance !== request.binding.instance
    ) {
      hold("transition request/scope binding is invalid");
    }
  }
  const rows = history
    .filter((row) => row.scope === scope)
    .sort((a, b) => a.id - b.id);
  const requests = rows.filter((row): row is Request => row.kind === "request");
  if (
    requests.some(
      (row) =>
        row.binding.repo !== cfg.repo || row.binding.base !== cfg.baseBranch,
    )
  ) {
    hold("request repository/base binding is invalid");
  }
  for (const keys of [
    rows.map((row) => row.operation),
    rows.map((row) => String(row.id)),
    requests.map((row) => row.token),
    requests.map((row) => row.binding.instance),
  ]) {
    if (new Set(keys).size !== keys.length) {
      hold("duplicate operation, token or instance");
    }
  }
  return rows;
}
function ownerAt(
  port: CoordinationPort,
  scope: string,
  view: Snapshot,
): Request | null {
  const token = port.lock(refOf(scope, view.epoch));
  const owner =
    view.records.find(
      (row): row is Request => row.kind === "request" && row.token === token,
    ) ?? null;
  if (token !== null && owner === null) {
    hold("lock has no authenticated request");
  }
  return owner;
}
function transition(
  port: CoordinationPort,
  scope: string,
  view: Snapshot,
  row: Row,
): void {
  if (row.kind === "request") {
    view.pending.push(row);
    return;
  }
  const request = view.pending.find((item) => item.id === row.request);
  if (request === undefined || request.binding.instance !== row.instance) {
    hold("mutation of an absent or released predecessor");
  }
  const current = ownerAt(port, scope, view);
  if (row.kind === "cancel") {
    if (current?.id === request.id) {
      hold("owner cannot cancel instead of release");
    }
    view.pending.splice(view.pending.indexOf(request), 1);
    return;
  }
  if (current?.id !== request.id) {
    hold("record does not match immutable epoch ownership");
  }
  applyOwned(view, row, request);
}
function applyOwned(
  view: Snapshot,
  row: Exclude<Row, Request>,
  request: Request,
): void {
  if (row.kind === "confirm") {
    if (view.confirmed) {
      hold("duplicate confirmation");
    }
    // A later, conflicting ref read cannot transfer this confirmation.
    view.owner = request;
    view.confirmed = true;
  } else if (!view.confirmed || view.owner?.id !== request.id) {
    hold("unconfirmed owner mutation");
  } else if (row.kind === "register" || row.kind === "done") {
    applyConsumer(view, row);
  } else if (row.kind === "release") {
    if (view.consumers.some((entry) => !entry.done)) {
      hold("released before every registered consumer reported done");
    }
    view.pending.splice(view.pending.indexOf(request), 1);
    view.epoch = row.id;
    view.owner = null;
    view.confirmed = false;
    view.consumers = [];
  }
}
function sameConsumer(a: Consumer, b: Consumer): boolean {
  return a.kind === b.kind && a.id === b.id;
}
function applyConsumer(
  view: Snapshot,
  row: Extract<Row, { kind: "register" | "done" }>,
): void {
  const entry = view.consumers.find((item) =>
    sameConsumer(item.consumer, row.consumer),
  );
  if (row.kind === "register") {
    if (entry !== undefined) {
      hold("consumer registered twice");
    }
    view.consumers.push({ consumer: row.consumer, done: false });
  } else if (entry === undefined || entry.done) {
    hold("done report without an outstanding registration");
  } else {
    entry.done = true;
  }
}
function snapshot(
  cfg: Config,
  port: CoordinationPort,
  scope: string,
): Snapshot {
  const records = recordsOf(cfg, port.comments(), scope);
  const view: Snapshot = {
    owner: null,
    confirmed: false,
    pending: [],
    epoch: 0,
    records,
    consumers: [],
  };
  for (const row of records) {
    transition(port, scope, view, row);
  }
  const owner = ownerAt(port, scope, view);
  if (view.confirmed && view.owner?.id !== owner?.id) {
    hold("immutable epoch ownership changed after confirmation");
  }
  view.owner = owner;
  if (
    owner !== null &&
    !view.pending.some((request) => request.id === owner.id)
  ) {
    hold("released lock reused in a later epoch");
  }
  return view;
}
// Every slot of `resource` on cfg's repository and base that a record in
// `comments` names, in order.
function resourceSlotsOf(
  cfg: Config,
  comments: readonly IssueComment[],
  resource: SharedResource,
): number[] {
  const slots = new Set<number>();
  for (const row of comments.flatMap((comment) => parseRecord(cfg, comment))) {
    const named = resourceOf(row.scope);
    if (
      named !== null &&
      named.repo === cfg.repo &&
      named.base === cfg.baseBranch &&
      named.resource === resource
    ) {
      slots.add(named.slot);
    }
  }
  return [...slots].sort((a, b) => a - b);
}
function sameBinding(a: InvocationBinding, b: InvocationBinding): boolean {
  return (
    a.instance === b.instance &&
    a.lane === b.lane &&
    a.issue === b.issue &&
    a.branch === b.branch &&
    a.repo === b.repo &&
    a.base === b.base
  );
}
function own(view: Snapshot, identity: InvocationBinding): Request {
  if (
    !view.confirmed ||
    view.owner?.binding.instance !== identity.instance ||
    !sameBinding(view.owner.binding, identity)
  ) {
    hold("execution ownership lost or unconfirmed");
  }
  return view.owner;
}

export type {
  Consumer,
  ConsumerState,
  CoordinationPort,
  Evidence,
  InvocationBinding,
  Record,
  RecordVersion,
  Request,
  SharedResource,
  Snapshot,
};

export {
  assertScope,
  bodyOf,
  END as RECORD_END,
  HEADER as RECORD_HEADER,
  hold,
  own,
  recordsOf,
  recordVersion,
  refOf,
  resourceScopeOf,
  resourceSlotsOf,
  sameBinding,
  sameConsumer,
  scopeOf,
  snapshot,
};
