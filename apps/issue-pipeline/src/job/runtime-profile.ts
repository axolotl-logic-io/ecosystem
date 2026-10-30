// Expand operator paths in the host, before shared runtime execution.
import path from "node:path";
import type { RuntimeConfig } from "@ecosystem/task-runtime/job/runtime-policy";
import { runtimeProfile as prepareRuntime } from "@ecosystem/task-runtime/job/runtime-profile";
import { expand, HOME, ROOT } from "../pipeline-root.ts";

function resolvedRuntime(
  runtime: RuntimeConfig | undefined,
): RuntimeConfig | undefined {
  if (runtime === undefined) {
    return undefined;
  }
  let { providerExtension } = runtime;
  if (providerExtension !== null) {
    providerExtension = expand(providerExtension);
  }
  return {
    ...runtime,
    home: expand(runtime.home ?? path.join(ROOT, "runtime", "home")),
    providerExtension,
  };
}

function runtimeProfile(
  input: Omit<Parameters<typeof prepareRuntime>[0], "parentHome">,
): ReturnType<typeof prepareRuntime> {
  return prepareRuntime({
    ...input,
    parentHome: HOME,
    runtime: resolvedRuntime(input.runtime),
  });
}

export { resolvedRuntime, runtimeProfile };
