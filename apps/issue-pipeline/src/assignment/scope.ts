import fs from "node:fs";
import { z } from "zod";
import type { Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import { OpsError } from "../ops-error.ts";

const MAX_REPOSITORIES = 50;
const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/])/u;
const MANIFEST = z.object({
  repositories: z
    .array(
      z.object({
        config: z.string().regex(ABSOLUTE),
        brainPath: z.string().regex(ABSOLUTE),
      }),
    )
    .min(1)
    .max(MAX_REPOSITORIES),
});
function readManifest(file: string): z.infer<typeof MANIFEST> {
  return MANIFEST.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
// The privileged paths originate only in the operator's invocation. Models
// do not receive this scope, and config files cannot inject an execution.
function freshScope(cfg: Config): Config {
  if (cfg.execution === undefined || cfg.configFile === undefined) {
    return cfg;
  }
  const { scope } = cfg.execution;
  if (scope === undefined || scope.config !== cfg.configFile) {
    throw new OpsError("missing worker repository allow-list provenance");
  }
  const fresh = repositoryScope(cfg, scope);
  return { ...fresh, execution: cfg.execution };
}
function repositoryScope(
  cfg: Config,
  scope: { manifest: string; config: string; brainPath: string },
): Config {
  const manifest = readManifest(scope.manifest);
  const entries = manifest.repositories.filter(
    (entry) =>
      entry.config === scope.config && entry.brainPath === scope.brainPath,
  );
  if (entries.length !== 1) {
    throw new OpsError(
      "repository removed from worker scope or mapping is ambiguous",
    );
  }
  const fresh = loadConfig(scope.config);
  if (
    fresh.repo !== cfg.repo ||
    fresh.baseBranch !== cfg.baseBranch ||
    fresh.devAccount !== cfg.devAccount ||
    fresh.mergeAccount !== cfg.mergeAccount
  ) {
    throw new OpsError(
      "repository identity or integration target changed; drain and reconcile",
    );
  }
  return fresh;
}

export { freshScope, readManifest, repositoryScope };
