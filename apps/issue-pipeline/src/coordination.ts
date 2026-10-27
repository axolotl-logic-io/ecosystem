// Authenticated requests/order live in comments. Immutable create-only epoch
// refs arbitrate contenders even when comment listings interleave. No expiry,
// ref deletion, private queue, discovery or scheduling loop grants permission.
import type { Config } from "./config.ts";
import {
  INVOCATION_BINDING,
  RESOURCE_RECORD_VERSION,
} from "./coordination-record-schema.ts";
import type {
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
} from "./coordination-records.ts";
import {
  assertScope,
  bodyOf,
  hold,
  own,
  recordVersion,
  refOf,
  resourceScopeOf,
  resourceSlotsOf,
  sameBinding,
  snapshot,
} from "./coordination-records.ts";

// One snapshot reads each epoch's create-only ref once, however many of its
// transitions consult it; the next snapshot reads them all afresh.
function onceRead(port: CoordinationPort): CoordinationPort {
  const refs = new Map<string, string | null>();
  return {
    ...port,
    lock: (ref: string): string | null => {
      if (!refs.has(ref)) {
        refs.set(ref, port.lock(ref));
      }
      return refs.get(ref) ?? null;
    },
  };
}

class Coordination {
  private readonly cfg: Config;
  private readonly port: CoordinationPort;
  private readonly scope: string;
  private readonly binding: InvocationBinding;
  private readonly version: RecordVersion;
  // The capacity a resource slot's request declares; undefined elsewhere.
  private readonly cap: number | undefined;
  constructor(
    cfg: Config,
    port: CoordinationPort,
    at: { scope: string; cap?: number },
    identity: InvocationBinding,
  ) {
    const { scope, cap } = at;
    this.cfg = cfg;
    this.port = port;
    this.scope = scope;
    this.binding = INVOCATION_BINDING.parse(identity);
    this.version = recordVersion(scope);
    this.cap = cap;
    if ((this.version === RESOURCE_RECORD_VERSION) !== (cap !== undefined)) {
      hold("only a resource slot request declares its capacity, and it must");
    }
    assertScope(scope, this.binding);
    if (identity.repo !== cfg.repo || identity.base !== cfg.baseBranch) {
      hold("execution repository/base binding changed");
    }
  }
  read(): Snapshot {
    return readScope(this.cfg, this.port, this.scope);
  }
  private append(record: Record): void {
    this.port.write(
      record.kind,
      (): void => this.port.append(bodyOf(record)),
      (): boolean => {
        const { records: rows } = snapshot(
          this.cfg,
          onceRead(this.port),
          record.scope,
        );
        const matches = rows.filter(
          (row) => row.operation === record.operation,
        );
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) {
          return false;
        }
        const { id: _id, ...saved } = match;
        return bodyOf(saved) === bodyOf(record);
      },
      bodyOf(record),
    );
  }
  request(): number {
    const view = this.read();
    const existing = view.pending.find(
      (item) => item.binding.instance === this.binding.instance,
    );
    if (existing !== undefined) {
      if (!sameBinding(existing.binding, this.binding)) {
        hold("instance identity changed");
      }
      return existing.id;
    }
    if (
      view.records.some(
        (row) =>
          row.kind === "request" &&
          row.binding.instance === this.binding.instance,
      )
    ) {
      hold("released instance cannot request again");
    }
    const request: Record = {
      version: this.version,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind: "request",
      binding: this.binding,
      token: this.port.token(this.binding),
    };
    if (this.cap === undefined) {
      this.append(request);
    } else {
      this.append({ ...request, cap: this.cap });
    }
    const saved = this.read().pending.find(
      (item) => item.binding.instance === this.binding.instance,
    );
    if (saved === undefined) {
      hold("request disappeared");
    }
    return saved.id;
  }
  acquire(): boolean {
    const view = this.read();
    const mine = view.pending.find(
      (item) => item.binding.instance === this.binding.instance,
    );
    if (mine === undefined || !sameBinding(mine.binding, this.binding)) {
      hold("exact request identity required before acquisition");
    }
    if (view.owner === null) {
      if (view.pending[0]?.id !== mine.id) {
        return false;
      }
      const ref = refOf(this.scope, view.epoch);
      this.port.write(
        "acquire",
        (): void => this.port.reserve(ref, mine.token),
        (): boolean => this.port.lock(ref) === mine.token,
        { ref, token: mine.token },
      );
    } else if (view.owner.id !== mine.id) {
      return false;
    }
    const reserved = this.read();
    if (reserved.owner?.id !== mine.id) {
      hold("immutable epoch reservation changed before confirmation");
    }
    if (!reserved.confirmed) {
      this.append({
        version: this.version,
        scope: this.scope,
        operation: crypto.randomUUID(),
        kind: "confirm",
        request: mine.id,
        instance: this.binding.instance,
      });
    }
    this.assertOwner();
    return true;
  }
  // The public execution boundary leaves nothing pending after a known loss.
  // An unknown response still retains its original request for reconciliation.
  tryAcquire(): boolean {
    this.request();
    if (this.acquire()) {
      return true;
    }
    this.cancel();
    return false;
  }
  assertOwner(): void {
    own(this.read(), this.binding);
  }
  private mutate(kind: "save" | "release", evidence?: Evidence): void {
    const view = this.read();
    const owner = own(view, this.binding);
    if (kind === "release" && view.consumers.some((entry) => !entry.done)) {
      hold("a registered consumer has not reported done");
    }
    this.append({
      version: this.version,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind,
      request: owner.id,
      instance: this.binding.instance,
      evidence,
    });
    const after = this.read();
    if (kind === "save") {
      own(after, this.binding);
    } else if (after.pending.some((item) => item.id === owner.id)) {
      hold("release not confirmed");
    }
  }
  save(evidence: Evidence): void {
    this.mutate("save", evidence);
  }
  release(): void {
    this.mutate("release");
  }
  // The confirmed owner's consumers of a resource slot, read afresh.
  consumers(): readonly ConsumerState[] {
    const view = this.read();
    own(view, this.binding);
    return view.consumers;
  }
  // Records, as the confirmed owner of a resource slot, that `consumer`
  // starts using it (`register`, before it starts) or is done with it.
  report(kind: "register" | "done", consumer: Consumer): void {
    if (this.version !== RESOURCE_RECORD_VERSION) {
      hold("only a resource slot has consumers");
    }
    const owner = own(this.read(), this.binding);
    this.append({
      version: RESOURCE_RECORD_VERSION,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind,
      request: owner.id,
      instance: this.binding.instance,
      consumer,
    });
    own(this.read(), this.binding);
  }
  // Retires an earlier invocation's request for the same work: a release
  // while it owns the confirmed scope, a cancel while it only waits. The
  // caller has read that the request's consumer is done and holds that
  // work's execution itself (ops/land-turn.ts); the record names it. A
  // resource slot is released only by its own holder, so none is retired.
  retire(request: Pick<Request, "id" | "binding">): void {
    if (this.version === RESOURCE_RECORD_VERSION) {
      hold("only its holder releases a resource slot");
    }
    const view = this.read();
    const row = view.pending.find((item) => item.id === request.id);
    if (
      row === undefined ||
      row.binding.instance === this.binding.instance ||
      !sameWork(row.binding, this.binding)
    ) {
      hold("only an earlier invocation of the same work can be retired");
    }
    const owned = view.owner?.id === row.id;
    if (owned && !view.confirmed) {
      hold("an earlier invocation reserved the scope without confirming it");
    }
    let kind: "release" | "cancel" = "cancel";
    if (owned) {
      kind = "release";
    }
    this.append({
      version: this.version,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind,
      request: row.id,
      instance: row.binding.instance,
      evidence: { retiredBy: this.binding.instance },
    });
    if (this.read().pending.some((item) => item.id === row.id)) {
      hold("retirement not confirmed");
    }
  }
  cancel(): void {
    const view = this.read();
    const mine = view.pending.find(
      (item) => item.binding.instance === this.binding.instance,
    );
    if (
      mine === undefined ||
      !sameBinding(mine.binding, this.binding) ||
      view.owner?.id === mine.id
    ) {
      hold("cannot cancel absent request or owner");
    }
    this.append({
      version: this.version,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind: "cancel",
      request: mine.id,
      instance: this.binding.instance,
    });
  }
}
// Two bindings of the same work: one issue and branch on one repository
// and base, under any lane or invocation.
function sameWork(a: InvocationBinding, b: InvocationBinding): boolean {
  return (
    a.issue === b.issue &&
    a.branch === b.branch &&
    a.repo === b.repo &&
    a.base === b.base
  );
}
// Observe one scope without constructing an invocation or requesting work.
// Cache immutable-ref reads within this snapshot, never across observations.
function readScope(
  cfg: Config,
  port: CoordinationPort,
  scope: string,
): Snapshot {
  return snapshot(cfg, onceRead(port), scope);
}

function coordination(
  cfg: Config,
  port: CoordinationPort,
  scope: string,
  identity: InvocationBinding,
): Coordination {
  return new Coordination(cfg, port, { scope }, identity);
}
// The coordination of a resource slot's scope, whose requests declare the
// capacity, `cap`, that its caller reserves under.
function slotCoordination(
  cfg: Config,
  port: CoordinationPort,
  slot: { scope: string; cap: number },
  identity: InvocationBinding,
): Coordination {
  return new Coordination(cfg, port, slot, identity);
}
// Each slot of `resource` on cfg's repository and base that a record names
// or `cap` covers, with its snapshot, all from one listing of the port's
// comments. The survey is read-only; every effect reads afresh.
function surveySlots(
  cfg: Config,
  port: CoordinationPort,
  resource: SharedResource,
  cap: number,
): ReadonlyMap<number, Snapshot> {
  const comments = port.comments();
  const listed = onceRead({ ...port, comments: () => comments });
  const slots = new Set(resourceSlotsOf(cfg, comments, resource));
  for (let slot = 1; slot <= cap; slot += 1) {
    slots.add(slot);
  }
  const at = { repo: cfg.repo, base: cfg.baseBranch };
  return new Map(
    [...slots]
      .sort((a, b) => a - b)
      .map((slot): [number, Snapshot] => [
        slot,
        snapshot(cfg, listed, resourceScopeOf(at, resource, slot)),
      ]),
  );
}

export type {
  Consumer,
  ConsumerState,
  CoordinationPort,
  Evidence,
  InvocationBinding,
  Request,
  SharedResource,
  Snapshot,
} from "./coordination-records.ts";
export { coordination, readScope, slotCoordination, surveySlots };
