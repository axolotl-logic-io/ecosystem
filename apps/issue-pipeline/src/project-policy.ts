// Project policy is data from an operator-pinned Git commit, never a candidate
// checkout. Only reproducible project settings cross this boundary.
import { createHash } from "node:crypto";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";
import type {
  ProjectPolicyBinding,
  ProjectPolicySource,
} from "./project-policy-schema.ts";
import {
  PROJECT_POLICY_SOURCE,
  PROJECT_SETTINGS,
} from "./project-policy-schema.ts";

const DOCUMENT = ".issue-pipeline.json";
const TREE_ENTRY =
  /^100644 blob (?<blob>[0-9a-f]{40})\t\.issue-pipeline\.json\n$/u;
const MAX_POLICY_BYTES = 131_071;
const GIT_TIMEOUT_MS = 30_000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Object key order and JSON whitespace confer no policy change. Arrays retain
// their order because command/path order can affect checking behavior.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function gitObject(
  source: ProjectPolicySource,
  args: readonly string[],
): string {
  return run(
    "git",
    ["--no-replace-objects", "-C", source.repository, ...args],
    {
      env: new Map([
        ["GIT_CONFIG_NOSYSTEM", "1"],
        ["GIT_CONFIG_GLOBAL", "/dev/null"],
        ["GIT_NO_LAZY_FETCH", "1"],
      ]),
      timeoutMs: GIT_TIMEOUT_MS,
    },
  ).stdout;
}

function committedSettings(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { projectPolicy } = raw;
  const source = PROJECT_POLICY_SOURCE.parse(projectPolicy);
  const { repo, cloneUrl } = raw;
  let expected = `https://github.com/${String(repo)}.git`;
  if (typeof cloneUrl === "string" && cloneUrl !== "") {
    if (!cloneUrl.startsWith("/") && cloneUrl !== expected) {
      throw new OpsError(
        "project policy requires the configured GitHub HTTPS repository or a local test origin",
      );
    }
    expected = cloneUrl;
  }
  const origin = gitObject(source, [
    "config",
    "--get-all",
    "remote.origin.url",
  ]).trim();
  if (origin !== expected) {
    throw new OpsError(
      "project policy source must have the configured repository origin",
    );
  }
  const type = gitObject(source, ["cat-file", "-t", source.revision]).trim();
  if (type !== "commit") {
    throw new OpsError(
      "project policy revision must name a commit, not a tag or blob",
    );
  }
  const entry = gitObject(source, ["ls-tree", source.revision, "--", DOCUMENT]);
  if (!TREE_ENTRY.test(entry)) {
    throw new OpsError(
      `project policy ${DOCUMENT} must be a committed regular file`,
    );
  }
  const text = gitObject(source, ["show", `${source.revision}:${DOCUMENT}`]);
  if (
    Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES ||
    text.includes("\u0000")
  ) {
    throw new OpsError("project policy document is oversized or contains NUL");
  }
  const settings = PROJECT_SETTINGS.parse(JSON.parse(text));
  for (const key of Object.keys(settings)) {
    if (Object.hasOwn(raw, key)) {
      throw new OpsError(
        `project policy setting ${key} must not also appear in operator config`,
      );
    }
  }
  return { ...raw, ...settings };
}

function resolveProjectSettings(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (Object.hasOwn(raw, "policyBinding")) {
    throw new OpsError(
      "policyBinding is computed, not a configuration setting",
    );
  }
  if (!Object.hasOwn(raw, "projectPolicy")) {
    return { ...raw };
  }
  // Refuse duplicates even when the committed document omits an optional key:
  // there is exactly one project-policy authority in committed mode.
  for (const key of Object.keys(PROJECT_SETTINGS.shape)) {
    if (Object.hasOwn(raw, key)) {
      throw new OpsError(
        `project policy setting ${key} must not also appear in operator config`,
      );
    }
  }
  return committedSettings(raw);
}

interface PolicyConfig {
  projectPolicy?: ProjectPolicySource | undefined;
  policyBinding?: ProjectPolicyBinding | undefined;
  [key: string]: unknown;
}

function computePolicyBinding(cfg: PolicyConfig): ProjectPolicyBinding {
  const effective = Object.fromEntries(
    [
      "commands",
      "practices",
      "lockfiles",
      "migrations",
      "requireCi",
      "ciWaitMinutes",
      "commandTimeoutMinutes",
    ].map((key) => [key, cfg[key]]),
  );
  const source = cfg.projectPolicy;
  if (source === undefined) {
    return {
      mode: "legacy",
      digest: sha256(canonical({ mode: "legacy", effective })),
    };
  }
  const entry = gitObject(source, ["ls-tree", source.revision, "--", DOCUMENT]);
  const match = TREE_ENTRY.exec(entry);
  const { blob } = match?.groups ?? {};
  if (blob === undefined) {
    throw new OpsError("project policy lost its committed regular file");
  }
  const text = gitObject(source, ["cat-file", "blob", blob]);
  const provenance = { source, blob, sha256: sha256(text), effective };
  return {
    mode: "committed",
    revision: source.revision,
    blob,
    sha256: provenance.sha256,
    digest: sha256(canonical(provenance)),
  };
}

// Loaded configs use their snapshot; in-process callers with parsed configs get
// the same computation. Requests may compare this value but cannot supply it.
function policyRevision(cfg: PolicyConfig): { policy: string } {
  return { policy: (cfg.policyBinding ?? computePolicyBinding(cfg)).digest };
}

function assertPolicyDigest(
  cfg: PolicyConfig,
  expected: string | undefined,
): void {
  if (expected !== undefined && policyRevision(cfg).policy !== expected) {
    throw new OpsError(
      "project checking policy changed since this job started; preserve work and restart with fresh checks/review",
    );
  }
}

export {
  assertPolicyDigest,
  computePolicyBinding,
  policyRevision,
  resolveProjectSettings,
};
