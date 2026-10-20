import type { Reason } from "./hold.ts";
import { DiscoveryHold } from "./hold.ts";
import type { Reads } from "./reads.ts";
import type { Repository, Settings } from "./schema.ts";

interface DiscoveryContext {
  reads: Reads;
  settings: Settings;
  repo: Repository;
}
interface WorkIdentity {
  repository: string;
  kind: "issue" | "pull" | "snapshot";
  number: number | null;
  login: string | null;
}
interface Hold extends WorkIdentity {
  reason: Reason;
  evidence: string;
  incomplete: boolean;
  deduplicationKey: string;
}
interface Candidate extends WorkIdentity {
  kind: "issue" | "pull";
  number: number;
  login: string;
  issue: number;
  worker: string;
  role: "development" | "review";
  stage: "author" | "implement" | "review" | "merge";
  inputs: string;
  grant: number;
  reviews: number[];
}
interface DiscoveryPlan {
  executionAuthority: false;
  complete: boolean;
  requests: number;
  candidates: Candidate[];
  holds: Hold[];
  // Retry descriptors, not resumable authority or a proof of unassignment.
  continuations: Hold[];
}
function holdFor(work: WorkIdentity, error: unknown): Hold {
  let hold = new DiscoveryHold({
    reason: "state",
    evidence: "unreadable-evidence",
    incomplete: true,
  });
  if (error instanceof DiscoveryHold) {
    hold = error;
  }
  return {
    ...work,
    reason: hold.reason,
    evidence: hold.evidence,
    incomplete: hold.incomplete,
    deduplicationKey: JSON.stringify([
      work.repository.toLowerCase(),
      work.kind,
      work.number,
      work.login?.toLowerCase() ?? null,
      hold.reason,
      hold.evidence,
    ]),
  };
}

export type { Candidate, DiscoveryContext, DiscoveryPlan, Hold, WorkIdentity };
export { holdFor };
