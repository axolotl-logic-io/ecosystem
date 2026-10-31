// Runs a model session with the installed agent templates and extensions;
// shared execution discovers none.
import path from "node:path";
import type {
  LaunchHooks,
  SessionLaunch,
} from "@ecosystem/task-runtime/job/launch";
import { runSession as executeSession } from "@ecosystem/task-runtime/job/launch";
import type { SessionRaw } from "@ecosystem/task-runtime/job/raw-results";
import { AGENT_DIR, HOME, installRoot } from "../host-paths.ts";
import { resolvedRuntime } from "./runtime-profile.ts";

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
    outputExtension: path.join(installRoot(), "structured-output.mjs"),
    commitExtension: path.join(installRoot(), "pipeline-commit.mjs"),
    parentHome: HOME,
  });
}

export { runSession };
