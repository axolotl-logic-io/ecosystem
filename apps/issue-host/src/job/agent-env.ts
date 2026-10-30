// Host translates legacy operator declarations into names to withhold.
import { modelEnvironment } from "@ecosystem/task-runtime/model-environment";
import type { LegacyAccessConfig } from "../config-schema.ts";

function agentEnvOf(
  config: LegacyAccessConfig | null | undefined,
  from: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const names = Object.values(config ?? {}).flatMap((settings): string[] => {
    if (settings?.tokenEnv === undefined) {
      return [];
    }
    return [settings.tokenEnv];
  });
  return modelEnvironment(from, names);
}

export { agentEnvOf };
