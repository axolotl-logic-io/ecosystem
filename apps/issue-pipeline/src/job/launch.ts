// Compatibility host provisions installed resources; shared execution discovers none.
import path from "node:path";
import type {
  LaunchHooks,
  SessionLaunch,
} from "@ecosystem/task-runtime/job/launch";
import { runSession as executeSession } from "@ecosystem/task-runtime/job/launch";
import type { SessionRaw } from "@ecosystem/task-runtime/job/raw-results";
import { AGENT_DIR, HOME, ROOT } from "../pipeline-root.ts";
import { resolvedRuntime } from "./runtime-profile.ts";

const OUTPUT_EXTENSION = path.join(ROOT, "structured-output.mjs");

function runSession(
  launch: SessionLaunch,
  hooks: LaunchHooks,
): Promise<SessionRaw> {
  const prepared = { ...hooks };
  const runtime = resolvedRuntime(hooks.runtime);
  if (runtime !== undefined) {
    prepared.runtime = runtime;
  }
  return executeSession(launch, prepared, {
    agentDirectory: path.join(AGENT_DIR, "agents", "issue-pipeline"),
    outputExtension: OUTPUT_EXTENSION,
    commitExtension: path.join(ROOT, "pipeline-commit.mjs"),
    parentHome: HOME,
  });
}

export { OUTPUT_EXTENSION, runSession };
