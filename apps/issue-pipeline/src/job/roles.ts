// The stage job's roles (sandbox-ready-jobs): the role each stage and each
// model session runs as, what each role may hold, and the environment a
// session's pi gets. A reader holds no GitHub token; a writer or merger holds
// only the one its config names, as GH_TOKEN. No session runs as merger, so
// no model holds merge credentials. The networks are recorded, not enforced.

import type { Config, JobRolesConfig } from "../config.ts";
import { paths } from "../config.ts";
import type { StageName } from "../workflow/stages/types.ts";

type JobRole = "reader" | "writer" | "merger";

// What a role may hold: the job variable its GH_TOKEN comes from, if any, and
// the hosts it may reach.
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
// conflict resolver and CI fixer do.
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
// The variable gh reads its token from first, which a session's token goes in.
const GH_TOKEN = "GH_TOKEN";
// The variables gh reads a token from.
const GH_TOKEN_VARS: readonly string[] = [
  GH_TOKEN,
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

// The token a role's GH_TOKEN carries: its tokenEnv's value, or null for a
// reader, no tokenEnv, or a variable that is unset or empty.
function roleTokenOf(
  role: JobRole,
  roles: Roles,
  from: EnvSource,
): string | null {
  if (role === "reader") {
    return null;
  }
  const { tokenEnv } = roles[role];
  if (tokenEnv === undefined) {
    return null;
  }
  const token = new Map(Object.entries(from)).get(tokenEnv);
  if (token === undefined || token === "") {
    return null;
  }
  return token;
}

// The environment a session of `role` runs with: the job's own `from`, less
// gh's token variables and every role's tokenEnv, plus GH_TOKEN for a writer
// or merger whose token is set.
function agentEnvOf(
  role: JobRole,
  roles: Roles,
  from: EnvSource,
): Record<string, string> {
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
  const token = roleTokenOf(role, roles, from);
  if (token !== null) {
    env.set(GH_TOKEN, token);
  }
  return Object.fromEntries(env);
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
    env: Object.keys(agentEnvOf(role, roles, from)).sort(byName),
    network: roles[role].network,
  };
}

export type { Boundary, EnvSource, JobRole, RoleSettings, Roles, SessionRole };
export { agentEnvOf, boundaryOf, rolesOf, STAGE_ROLES, sessionRoleOf };
