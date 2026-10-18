// The stage job's roles (sandbox-ready-jobs): the role each stage runs as,
// which sessions commit and which are held to the context limits, each
// stage's access to its code and wiki checkouts and what its sessions may
// commit, what each role may
// hold, the environment a session's pi gets and the token budget its
// job.json records. No session holds a GitHub token: only the job does, and
// the sessions that commit push through it (`pipeline_commit`). The networks
// are recorded, not enforced.

import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { JobRolesConfig } from "../config-schema.ts";
import type { ChildSpec } from "../workflow/launches.ts";
import type { StageName } from "../workflow/stages/types.ts";
import { JOB_DOCS, JOB_REPO } from "./layout.ts";
import type { Access, PathScope } from "./pipeline-commit.ts";
import { COMMIT_SCOPE_ENV } from "./pipeline-commit.ts";

type JobRole = "reader" | "writer" | "merger";

// What a role may hold: the job variable its token comes from, if any, which
// is hidden from every session, and the hosts it may reach.
interface RoleSettings {
  tokenEnv: string | undefined;
  network: readonly string[];
}

type Roles = Readonly<Record<JobRole, RoleSettings>>;

// An environment as a process sees it: unset variables read as undefined.
type EnvSource = Readonly<Record<string, string | undefined>>;

// A stage's access to each of its job's checkouts: the code's (repo/) and
// the wiki's (docs/).
interface CheckoutAccess {
  repo: Access;
  docs: Access;
}

// What a stage job declares about itself for a sandbox: its role, the
// folder it works in, its access to each checkout there, the names of its
// sessions' env, and its network.
interface Boundary {
  role: JobRole;
  checkout: string;
  access: CheckoutAccess;
  env: string[];
  network: readonly string[];
}

// The role each stage's job runs as. spec writes because the spec writer
// commits its tests, stubs and wiki updates; sync and checks write because
// their conflict resolver and CI fixer do. merge and publish run as merger; their
// wiki conflict resolvers' sessions run as writers, as every writer session
// does.
const STAGE_ROLES: Readonly<Record<StageName, JobRole>> = {
  triage: "reader",
  spec: "writer",
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
// "Wiki provisioning"): every stage at least reads it (every-role-reads-wiki,
// #338); the spec writer writes the wiki, as merge and publish do when they
// rebase and publish its commits; every other stage reads it.
const STAGE_WIKI_ACCESS: Readonly<Record<StageName, Access>> = {
  triage: "read",
  spec: "write",
  implement: "read",
  "open-pr": "read",
  review: "read",
  fix: "read",
  sync: "read",
  checks: "read",
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

// The installed agent whose sessions write code.
const WRITER_AGENT = "issue-pipeline-writer";
// The installed agent whose sessions write the spec, its tests and stubs.
const SPEC_AGENT = "issue-pipeline-specifier";
// The variables gh reads a token from.
const GH_TOKEN_VARS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

// Whether a model session of installed agent `agent` commits, through
// `pipeline_commit`: the writer's and the specifier's do, every other reads.
function commitsOf(agent: string): boolean {
  return agent === WRITER_AGENT || agent === SPEC_AGENT;
}

// Whether a session of `agent` is held to the config's `contextLimits` and
// records a token budget: the writer's and the specifier's (#335).
function heldToLimits(agent: string): boolean {
  return agent === WRITER_AGENT || agent === SPEC_AGENT;
}

// The token budget job.json records for `spec`'s session, which the
// orchestrator's watchdog stops it past: its budget for a session held to
// the limits, and null, no watchdog max, for any other (Axlog, 2026-10-16).
function recordedBudgetOf(spec: ChildSpec): number | null {
  if (heldToLimits(spec.agent)) {
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
// token variables, every role's tokenEnv and any commit scope the job itself
// was given, so that only a committing session gets one, its own.
function agentEnvOf(roles: Roles, from: EnvSource): Record<string, string> {
  const hidden = new Set([...GH_TOKEN_VARS, COMMIT_SCOPE_ENV]);
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

// A stage's access to its code checkout: a writer stage writes it, and a
// reader or merger stage only reads it.
function codeAccessOf(stage: StageName): Access {
  if (STAGE_ROLES[stage] === "writer") {
    return "write";
  }
  return "read";
}

// What a writer session of `stage` may commit: its code checkout and its
// wiki checkout (null when the job has none, `hasWiki` false) as the stage's
// access allows, and the code globs, relative to the code checkout, it may
// commit there: any code path, but none for a merger stage.
function commitScopeOf(stage: StageName, hasWiki: boolean): PathScope {
  const allowed: string[] = [];
  if (STAGE_ROLES[stage] !== "merger") {
    allowed.push("**");
  }
  const repo = { dir: JOB_REPO, access: codeAccessOf(stage) };
  let docs: PathScope["docs"] = null;
  if (hasWiki) {
    docs = { dir: JOB_DOCS, access: STAGE_WIKI_ACCESS[stage] };
  }
  return { repo, docs, allowed };
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
    access: { repo: codeAccessOf(stage), docs: STAGE_WIKI_ACCESS[stage] },
    env: Object.keys(agentEnvOf(roles, from)).sort(byName),
    network: roles[role].network,
  };
}

export type {
  Boundary,
  CheckoutAccess,
  EnvSource,
  JobRole,
  RoleSettings,
  Roles,
};
export {
  agentEnvOf,
  boundaryOf,
  codeAccessOf,
  commitScopeOf,
  commitsOf,
  heldToLimits,
  recordedBudgetOf,
  rolesOf,
  SPEC_AGENT,
  STAGE_ROLES,
  STAGE_WIKI_ACCESS,
};
