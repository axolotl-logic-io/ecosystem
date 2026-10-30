import type { SessionPhase } from "../domain.ts";
import type { PathScope } from "./pipeline-commit.ts";

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

export type { LaunchStart, StopSignal };
