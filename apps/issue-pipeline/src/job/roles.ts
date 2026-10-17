// The stage job's roles (sandbox-ready-jobs): the role each stage and each
// model session runs as, each stage's wiki access and what its writer
// sessions may commit, what each role may hold, the environment a
// session's pi gets and the token budget its job.json records. No session holds a GitHub token: only the job does, and
// its writer sessions commit and push through it (`pipeline_commit`). No
// session runs as merger. The networks are recorded, not enforced.

import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { JobRolesConfig } from "../config-schema.ts";
import type { ChildSpec } from "../workflow/launches.ts";
import type { StageName } from "../workflow/stages/types.ts";
import type { PathScope, WikiAccess } from "./pipeline-commit.ts";

type JobRole = "reader" | "writer" | "merger";

// What a role may hold: the job variable its token comes from, if any, which
// is hidden from every session, and the hosts it may reach.
interface RoleSettings {
  tokenEnv: string | undefined;
  network: readonly string[];
}

// No model session runs as merger.
type SessionRole = Exclude<JobRole, "merger">;

type Roles = Readonly<Record<JobRole, RoleSettings>>;

// An environment as a process sees it: unset variables read as undefined.
type EnvSource = Readonly<Record<string, string | undefined>>;

// What a stage job declares about itself for a sandbox: its role, the
// checkout it works in, the names of its sessions' env, and its network.
interface Boundary {
  role: JobRole;
  checkout: string;
  env: string[];
  network: readonly string[];
}

// The role each stage's job runs as. sync and checks write because their
// conflict resolver and CI fixer do. merge and publish run as merger; their
// wiki conflict resolvers' sessions run as writers, as every writer session
// does.
const STAGE_ROLES: Readonly<Record<StageName, JobRole>> = {
  triage: "reader",
  spec: "reader",
  implement: "writer",
  "open-pr": "writer",
  review: "reader",
  fix: "writer",
  sync: "writer",
  checks: "writer",
  accept: "reader",
  security: "reader",
  merge: "merger",
  publish: "merger",
};

// Each stage's access to the issue's wiki checkout (Pipeline-Roles-Shared,
// "Wiki provisioning"): the spec writer writes the wiki, as merge and publish
// do when they rebase and publish its commits; every other stage reads it.
// Until the spec writer commits the spec's wiki updates (#300 part 5d), a
// bridge (2026-10-17): the implementer and fixer make them, as before #303,
// and checks' CI fixer fixes the pages the wiki check fails, so implement,
// fix and checks write it too.
const STAGE_WIKI_ACCESS: Readonly<Record<StageName, WikiAccess>> = {
  triage: "read",
  spec: "write",
  implement: "write",
  "open-pr": "read",
  review: "read",
  fix: "write",
  sync: "read",
  checks: "write",
  accept: "read",
  security: "read",
  merge: "write",
  publish: "write",
};

const DEFAULT_ROLES: Roles = {
  reader: { tokenEnv: undefined, network: ["api.anthropic.com"] },
  writer: {
    tokenEnv: undefined,
    network: ["api.anthropic.com", "registry.npmjs.org"],
  },
  merger: { tokenEnv: undefined, network: ["api.github.com"] },
};

// The installed agent whose sessions write.
const WRITER_AGENT = "issue-pipeline-writer";
// The variables gh reads a token from.
const GH_TOKEN_VARS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

// The role a model session of installed agent `agent` runs as: writer for the
// writer agent, reader for every other.
function sessionRoleOf(agent: string): SessionRole {
  if (agent === WRITER_AGENT) {
    return "writer";
  }
  return "reader";
}

// The token budget job.json records for `spec`'s session, which the
// orchestrator's watchdog stops it past: its budget for a writer session, and
// null, no watchdog max, for any other (Axlog, 2026-10-16).
function recordedBudgetOf(spec: ChildSpec): number | null {
  if (sessionRoleOf(spec.agent) === "writer") {
    return spec.tokenBudget;
  }
  return null;
}

function mergedRole(
  base: RoleSettings,
  entry: JobRolesConfig["reader"],
): RoleSettings {
  return {
    tokenEnv: entry?.tokenEnv ?? base.tokenEnv,
    network: entry?.network ?? base.network,
  };
}

// The roles' settings: the defaults, overridden field by field by the
// config's jobRoles.
function rolesOf(config: JobRolesConfig | null | undefined): Roles {
  return {
    reader: mergedRole(DEFAULT_ROLES.reader, config?.reader),
    writer: mergedRole(DEFAULT_ROLES.writer, config?.writer),
    merger: mergedRole(DEFAULT_ROLES.merger, config?.merger),
  };
}

// The environment every session runs with: the job's own `from`, less gh's
// token variables and every role's tokenEnv.
function agentEnvOf(roles: Roles, from: EnvSource): Record<string, string> {
  const hidden = new Set(GH_TOKEN_VARS);
  for (const settings of Object.values(roles)) {
    if (settings.tokenEnv !== undefined) {
      hidden.add(settings.tokenEnv);
    }
  }
  const env = new Map<string, string>();
  for (const [name, value] of Object.entries(from)) {
    if (value !== undefined && !hidden.has(name)) {
      env.set(name, value);
    }
  }
  return Object.fromEntries(env);
}

// What a writer session of `stage` may commit: the merger stages commit only
// the wiki, and every other stage any code path; the wiki as the stage's
// access allows. `wikiDir` is the wiki's folder in the checkout, or null.
function commitScopeOf(stage: StageName, wikiDir: string | null): PathScope {
  const allowed: string[] = [];
  if (STAGE_ROLES[stage] !== "merger") {
    allowed.push("**");
  }
  return { wikiDir, wikiAccess: STAGE_WIKI_ACCESS[stage], allowed };
}

function byName(a: string, b: string): -1 | 0 | 1 {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

// The boundary of issue `issue`'s `stage` job, with the env's names only.
function boundaryOf(
  cfg: Config,
  issue: number,
  stage: StageName,
  from: EnvSource,
): Boundary {
  const role = STAGE_ROLES[stage];
  const roles = rolesOf(cfg.jobRoles);
  return {
    role,
    checkout: paths.jobCheckout(cfg, issue, stage),
    env: Object.keys(agentEnvOf(roles, from)).sort(byName),
    network: roles[role].network,
  };
}

export type { Boundary, EnvSource, JobRole, RoleSettings, Roles, SessionRole };
export {
  agentEnvOf,
  boundaryOf,
  commitScopeOf,
  recordedBudgetOf,
  rolesOf,
  STAGE_ROLES,
  STAGE_WIKI_ACCESS,
  sessionRoleOf,
};
