type Reason =
  | "repository"
  | "mapping"
  | "role"
  | "provenance"
  | "scope"
  | "state"
  | "stop"
  | "needs-info"
  | "dependency"
  | "inputs"
  | "budget"
  | "read"
  | "page";

class DiscoveryHold extends Error {
  readonly reason: Reason;
  readonly evidence: string;
  readonly incomplete: boolean;

  constructor(
    details: { reason: Reason; evidence: string; incomplete?: boolean },
    options?: ErrorOptions,
  ) {
    super(`${details.reason}: ${details.evidence}`, options);
    this.reason = details.reason;
    this.evidence = details.evidence;
    this.incomplete = details.incomplete ?? false;
  }
}

export type { Reason };
export { DiscoveryHold };
