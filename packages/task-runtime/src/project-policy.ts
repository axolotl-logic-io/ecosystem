// Project policy is data from an operator-pinned Git commit, never a candidate
// checkout. Only reproducible project settings cross this boundary.
import { createHash } from "node:crypto";
import { run } from "./command.ts";
import { OpsError } from "./ops-error.ts";
import type {
  ProjectPolicyBinding,
  ProjectPolicySource,
} from "./project-policy-schema.ts";
import {
  PROJECT_POLICY_SOURCE,
  PROJECT_SETTINGS,
  parseProjectSettings,
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
function compareKeys(a: string, b: string): -1 | 0 | 1 {
  if (a === b) {
    return 0;
  }
  if (a < b) {
    return -1;
  }
  return 1;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
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
      cwd: source.repository,
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
  return { ...raw, ...readTrustedProjectSettings(source, expected) };
}

// The host supplies repository identity and an immutable policy pin. Only Git
// objects are read; candidate working-tree settings never become authority.
function readTrustedProjectSettings(
  source: ProjectPolicySource,
  expectedOrigin: string,
): ReturnType<typeof parseProjectSettings> {
  PROJECT_POLICY_SOURCE.parse(source);
  const origin = gitObject(source, [
    "config",
    "--null",
    "--get-all",
    "remote.origin.url",
  ]);
  // Exact framing requires one raw value; blank extras and padding reject.
  if (origin !== `${expectedOrigin}\u0000`) {
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
  const object = `${source.revision}:${DOCUMENT}`;
  const size = Number(gitObject(source, ["cat-file", "-s", object]).trim());
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_POLICY_BYTES) {
    throw new OpsError("project policy document is empty or oversized");
  }
  const text = gitObject(source, ["cat-file", "blob", object]);
  if (
    Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES ||
    text.includes("\u0000") ||
    text.includes("\ufffd")
  ) {
    throw new OpsError(
      "project policy document is oversized or contains invalid text",
    );
  }
  const settings = parseProjectSettings(text);
  return settings;
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
    throw new OpsError(
      "config must pin projectPolicy: the repository's committed .issue-pipeline.json is its only project-settings source",
    );
  }
  // Refuse duplicates even when the committed document omits an optional key:
  // there is exactly one project-policy authority.
  for (const key of Object.keys(PROJECT_SETTINGS.shape)) {
    if (Object.hasOwn(raw, key)) {
      throw new OpsError(
        `project policy setting ${key} must not also appear in operator config`,
      );
    }
  }
  return committedSettings(raw);
}

interface PolicySnapshot {
  projectPolicy: ProjectPolicySource;
  policyBinding?: ProjectPolicyBinding | undefined;
  commands?: unknown;
  practices?: unknown;
  lockfiles?: unknown;
  migrations?: unknown;
  requireCi?: unknown;
  ciWaitMinutes?: unknown;
  commandTimeoutMinutes?: unknown;
  permissions?: unknown;
}

function computePolicyBinding(cfg: PolicySnapshot): ProjectPolicyBinding {
  const {
    commands,
    practices,
    lockfiles,
    migrations,
    requireCi,
    ciWaitMinutes,
    commandTimeoutMinutes,
    permissions,
  } = cfg;
  const effective = {
    commands,
    practices,
    lockfiles,
    migrations,
    requireCi,
    ciWaitMinutes,
    commandTimeoutMinutes,
    permissions,
  };
  const source = cfg.projectPolicy;
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
    settings: effective,
    revision: source.revision,
    blob,
    sha256: provenance.sha256,
    digest: sha256(canonical(provenance)),
  };
}

// Loaded configs use their snapshot; in-process callers with parsed configs get
// the same computation. Requests may compare this value but cannot supply it.
function configPolicyDigest(cfg: PolicySnapshot): string {
  return (cfg.policyBinding ?? computePolicyBinding(cfg)).digest;
}

function policyRevision(cfg: PolicySnapshot): { policy: string } {
  return { policy: configPolicyDigest(cfg) };
}

function assertPolicyDigest(
  cfg: PolicySnapshot,
  expected: string | undefined,
): void {
  if (expected !== undefined && configPolicyDigest(cfg) !== expected) {
    throw new OpsError(
      "project checking policy changed since this job started; preserve work and restart with fresh checks/review",
    );
  }
}

export {
  assertPolicyDigest,
  computePolicyBinding,
  configPolicyDigest,
  policyRevision,
  readTrustedProjectSettings,
  resolveProjectSettings,
};
