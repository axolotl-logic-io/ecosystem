// Storage-independent ownership state. Git epoch tokens, comment IDs and
// replay records are private to the legacy GitHub backend.
import type { Claim, Consumer, Evidence, View } from "@ecosystem/db/protocol";

interface ExecutionCoordinator {
  read: () => View;
  tryAcquire: () => boolean;
  assertOwner: () => void;
  save: (evidence: Evidence) => void;
  release: () => void;
  consumers: () => Readonly<View["consumers"]>;
  report: (kind: "register" | "done", consumer: Consumer) => void;
  retire: (request: Pick<Claim, "id" | "binding">) => void;
}

export type { ExecutionCoordinator };
