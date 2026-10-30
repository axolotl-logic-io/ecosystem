// Model-child isolation. The legacy jobRoles operator key supplies additional
// credential-variable names to remove; network declarations grant no access.
import { childEnvironment } from "@ecosystem/task-runtime/child-env";
import { COMMIT_SCOPE_ENV } from "@ecosystem/task-runtime/job/pipeline-commit";
import type { LegacyAccessConfig } from "../config-schema.ts";

type EnvSource = Readonly<Record<string, string | undefined>>;

// Remove credentials and inherited commit scope. Only the current session's
// explicit commit boundary may later supply its own scope.
function agentEnvOf(
  config: LegacyAccessConfig | null | undefined,
  from: EnvSource,
): Record<string, string> {
  const hidden = new Set([COMMIT_SCOPE_ENV]);
  for (const settings of Object.values(config ?? {})) {
    if (settings?.tokenEnv !== undefined) {
      hidden.add(settings.tokenEnv);
    }
  }
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(childEnvironment(from))) {
    if (value !== undefined && !hidden.has(name)) {
      env.set(name, value);
    }
  }
  return Object.fromEntries(env);
}

export { agentEnvOf };
