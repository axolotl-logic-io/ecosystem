// Authenticated requests/order live in comments. Immutable create-only epoch
// refs arbitrate contenders even when comment listings interleave. No expiry,
// ref deletion, private queue, discovery or scheduling loop grants permission.
import type { Config } from "./config.ts";
import type {
  CoordinationPort,
  Evidence,
  Identity,
  Record,
  Snapshot,
} from "./coordination-records.ts";
import {
  assertScope,
  bodyOf,
  hold,
  IDENTITY,
  own,
  refOf,
  sameIdentity,
  snapshot,
} from "./coordination-records.ts";

class Coordination {
  private readonly cfg: Config;
  private readonly port: CoordinationPort;
  private readonly scope: string;
  private readonly identity: Identity;
  constructor(
    cfg: Config,
    port: CoordinationPort,
    scope: string,
    identity: Identity,
  ) {
    this.cfg = cfg;
    this.port = port;
    this.scope = scope;
    this.identity = IDENTITY.parse(identity);
    assertScope(scope, this.identity);
    if (identity.repo !== cfg.repo || identity.base !== cfg.baseBranch) {
      hold("execution repository/base binding changed");
    }
  }
  read(): Snapshot {
    return snapshot(this.cfg, this.port, this.scope);
  }
  private append(record: Record): void {
    this.port.write(
      record.kind,
      (): void => this.port.append(bodyOf(record)),
      (): boolean => {
        const { records: rows } = snapshot(this.cfg, this.port, record.scope);
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
      (item) => item.identity.instance === this.identity.instance,
    );
    if (existing !== undefined) {
      if (!sameIdentity(existing.identity, this.identity)) {
        hold("instance identity changed");
      }
      return existing.id;
    }
    if (
      view.records.some(
        (row) =>
          row.kind === "request" &&
          row.identity.instance === this.identity.instance,
      )
    ) {
      hold("released instance cannot request again");
    }
    this.append({
      version: 1,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind: "request",
      identity: this.identity,
      token: this.port.token(this.identity),
    });
    const saved = this.read().pending.find(
      (item) => item.identity.instance === this.identity.instance,
    );
    if (saved === undefined) {
      hold("request disappeared");
    }
    return saved.id;
  }
  acquire(): boolean {
    const view = this.read();
    const mine = view.pending.find(
      (item) => item.identity.instance === this.identity.instance,
    );
    if (mine === undefined || !sameIdentity(mine.identity, this.identity)) {
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
        version: 1,
        scope: this.scope,
        operation: crypto.randomUUID(),
        kind: "confirm",
        request: mine.id,
        instance: this.identity.instance,
      });
    }
    this.assertOwner();
    return true;
  }
  assertOwner(): void {
    own(this.read(), this.identity);
  }
  private mutate(kind: "save" | "release", evidence?: Evidence): void {
    const owner = own(this.read(), this.identity);
    this.append({
      version: 1,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind,
      request: owner.id,
      instance: this.identity.instance,
      evidence,
    });
    const after = this.read();
    if (kind === "save") {
      own(after, this.identity);
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
  cancel(): void {
    const view = this.read();
    const mine = view.pending.find(
      (item) => item.identity.instance === this.identity.instance,
    );
    if (
      mine === undefined ||
      !sameIdentity(mine.identity, this.identity) ||
      view.owner?.id === mine.id
    ) {
      hold("cannot cancel absent request or owner");
    }
    this.append({
      version: 1,
      scope: this.scope,
      operation: crypto.randomUUID(),
      kind: "cancel",
      request: mine.id,
      instance: this.identity.instance,
    });
  }
}
function coordination(
  cfg: Config,
  port: CoordinationPort,
  scope: string,
  identity: Identity,
): Coordination {
  return new Coordination(cfg, port, scope, identity);
}

export type {
  CoordinationPort,
  Evidence,
  Identity,
  Snapshot,
} from "./coordination-records.ts";
export { coordination };
