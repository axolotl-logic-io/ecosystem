// The stage job's roles (sandbox-ready-jobs): the role each stage runs as,
// the sessions each stage may run and which of them commit, each stage's
// access to its code and wiki checkouts and what its committing sessions may
// commit, what each role may hold, and the environment a session's pi gets.
// Write authority is each session's own (`SessionSpec.commits`), never its
// agent's: the reviewer commits while it hardens or integrates and only
// reads in its final security review of the integrated result. No session
// holds a GitHub token: only the job does, and the sessions that commit push
// through it (`pipeline_commit`).
// The networks are recorded, not enforced, and nothing here isolates a
// session's files or keyring from the OS user it runs as.

import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { ModelRole } from "../config-legacy.ts";
import type { JobRolesConfig } from "../config-schema.ts";
import type { Stage } from "../stages.ts";
import { JOB_DOCS, JOB_REPO } from "./layout.ts";
import type { Access, PathScope } from "./pipeline-commit.ts";
import { COMMIT_SCOPE_ENV } from "./pipeline-commit.ts";
import type { AgentName, SessionPhase, SessionSpec } from "./role-context.ts";

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
// folder it works in, its access to each checkout there (what its committing
// sessions may commit; a read-only session, such as the reviewer's final
// security review, commits nothing), the names of its sessions' env, and its
// network.
interface Boundary {
  role: JobRole;
  checkout: string;
  access: CheckoutAccess;
  env: string[];
  network: readonly string[];
}

// The role each stage's job runs as (Reimagined-Pipeline): the author only
// reads; the implementor and the reviewer, which hardens the change, write;
// merge holds the credentials for its deterministic merge and publication,
// and its model sessions, which integrate the change and then review its
// security, never get them.
const STAGE_ROLES: Readonly<Record<Stage, JobRole>> = {
  author: "reader",
  implement: "writer",
  review: "writer",
  merge: "merger",
};

// Each stage's access to the issue's code checkout, which its committing
// sessions get: the author only reads it; the implementor writes it, the
// reviewer hardens it, and merge's integration rebases and fixes it.
const STAGE_CODE_ACCESS: Readonly<Record<Stage, Access>> = {
  author: "read",
  implement: "write",
  review: "write",
  merge: "write",
};

// Each stage's access to the issue's wiki checkout: every stage reads it;
// the implementor writes its wiki updates, the reviewer hardens them, and
// merge rebases and publishes them.
const STAGE_WIKI_ACCESS: Readonly<Record<Stage, Access>> = {
  author: "read",
  implement: "write",
  review: "write",
  merge: "write",
};

// One kind of session a stage runs: the phase its spec names (null for
// none) and the write authority that phase has.
interface StageSession {
  phase: SessionPhase | null;
  commits: boolean;
}

// The installed agent a stage's sessions run as, the model role it plays,
// and the sessions it runs.
interface StageAgent {
  agent: AgentName;
  role: ModelRole;
  sessions: readonly StageSession[];
}

const REVIEWER_AGENT = "issue-pipeline-reviewer";

// The one installed agent each stage's sessions may run as, and its
// sessions: the author's only read; the implementor's commit; the reviewer
// hardens, committing, in review; and merge runs the reviewer's committing
// integration (its own final synchronization, conflict and check fixes) and
// then its read-only security review of the merged result. A reviewer
// session always names its phase; none reads before merge.
const STAGE_AGENTS: Readonly<Record<Stage, StageAgent>> = {
  author: {
    agent: "issue-pipeline-author",
    role: "author",
    sessions: [{ phase: null, commits: false }],
  },
  implement: {
    agent: "issue-pipeline-implementor",
    role: "implementor",
    sessions: [{ phase: null, commits: true }],
  },
  review: {
    agent: REVIEWER_AGENT,
    role: "reviewer",
    sessions: [{ phase: "hardening", commits: true }],
  },
  merge: {
    agent: REVIEWER_AGENT,
    role: "reviewer",
    sessions: [
      { phase: "integration", commits: true },
      { phase: "security-review", commits: false },
    ],
  },
};

const DEFAULT_ROLES: Roles = {
  reader: { tokenEnv: undefined, network: ["api.anthropic.com"] },
  writer: {
    tokenEnv: undefined,
    network: ["api.anthropic.com", "registry.npmjs.org"],
  },
  merger: {
    tokenEnv: undefined,
    network: ["api.github.com", "api.anthropic.com", "registry.npmjs.org"],
  },
};

// The variables gh reads a token from.
const GH_TOKEN_VARS: readonly string[] = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

// Why session `spec` may not run in a `stage` job, or null when it may: the
// stage runs only its one agent, and only the sessions it lists, each with
// its phase's write authority. A spec the stage has no session for, such as a
// reviewer session that names no phase, is refused, so its prompt and
// authority are never guessed.
function sessionRefusalOf(
  stage: Stage,
  spec: { agent: string } & Pick<SessionSpec, "commits" | "phase">,
): string | null {
  const allowed = STAGE_AGENTS[stage];
  if (allowed.agent !== spec.agent) {
    return `the ${stage} stage can't run ${spec.agent}`;
  }
  const phase = spec.phase ?? null;
  const session = allowed.sessions.find((entry) => entry.phase === phase);
  const named = phase ?? "unphased";
  if (session === undefined) {
    return `the ${stage} stage runs no ${named} session`;
  }
  if (session.commits !== spec.commits) {
    return `the ${stage} stage's ${named} session can't set commits ${spec.commits}`;
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

// What a committing session of `stage` may commit: its code checkout and its
// wiki checkout (null when the job has none, `hasWiki` false) as the stage's
// access allows, and the code globs, relative to the code checkout, it may
// commit there: any code path only while fresh authority permits code writes,
// else none. This scopes the commit tool, not OS filesystem access.
function commitScopeOf(
  stage: Stage,
  hasWiki: boolean,
  codeWritable: boolean,
): PathScope {
  let access = STAGE_CODE_ACCESS[stage];
  if (!codeWritable) {
    access = "read";
  }
  const allowed: string[] = [];
  if (access === "write") {
    allowed.push("**");
  }
  const repo = { dir: JOB_REPO, access };
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
  stage: Stage,
  from: EnvSource,
): Boundary {
  const role = STAGE_ROLES[stage];
  const roles = rolesOf(cfg.jobRoles);
  return {
    role,
    checkout: paths.jobCheckout(cfg, issue, stage),
    access: { repo: STAGE_CODE_ACCESS[stage], docs: STAGE_WIKI_ACCESS[stage] },
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
  StageAgent,
};
export {
  agentEnvOf,
  boundaryOf,
  commitScopeOf,
  rolesOf,
  STAGE_AGENTS,
  STAGE_CODE_ACCESS,
  STAGE_ROLES,
  STAGE_WIKI_ACCESS,
  sessionRefusalOf,
};
