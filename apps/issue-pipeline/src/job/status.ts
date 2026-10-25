// Launch observations shared by the action's control socket, ops runner,
// commit server and local context log. Canonical run files are written by
// runtime/observations.ts; this module writes no historical job.json.
import type {
  LaunchOutcome,
  LaunchPush,
  LaunchRecord,
} from "./launch-record.ts";
import type { PathScope } from "./pipeline-commit.ts";
import type { SessionPhase } from "./role-context.ts";

type StopSignal = "SIGTERM" | "SIGINT";

interface LaunchStart {
  key: string;
  kind: "session" | "ops";
  pid: number | null;
  session: string | null;
  commits?: boolean;
  scope?: PathScope | null;
  phase?: SessionPhase | null;
  prompt?: { page: string; sha256: string } | null;
}

interface JobStatus {
  started: (launch: LaunchStart) => void;
  record: (key: string, record: unknown) => void;
  ended: (key: string) => void;
  pushed: (key: string, push: LaunchPush) => void;
  settled: (key: string, outcome: LaunchOutcome) => void;
  launch: (key: string) => LaunchRecord | null;
  // The legacy-labelled context-log field holds the current task ID. It is
  // not a saved workflow position or a scheduling cursor.
  currentStage: () => string;
}

export type { JobStatus, LaunchStart, StopSignal };
