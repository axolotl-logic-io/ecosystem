// The stage job's roles (sandbox-ready-jobs): the role each stage runs as,
// the sessions each stage may run and which of them commit, each stage's
// access to its code checkout and what its committing sessions may commit,
// what each role may hold, and the environment a session's pi gets.
// Write authority is each session's own (`SessionSpec.commits`), never its
// agent's: the reviewer commits while it hardens and only reads in its
// security review of the candidate. A task job (`--task`, #186) runs as its
// task's access profile (`least-privilege-per-task`): Sync as a writer,
// Integration as a reader. No session
// holds a GitHub token: only the job does, and the sessions that commit push
// through it (`pipeline_commit`).
// The networks are recorded, not enforced, and nothing here isolates a
// session's files or keyring from the OS user it runs as.

import { childEnvironment } from "../child-env.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { ModelRole } from "../config-legacy.ts";
import type { JobRolesConfig } from "../config-schema.ts";
import type { Stage } from "../stages.ts";
import { JOB_REPO } from "./layout.ts";
import type { Access, PathScope } from "./pipeline-commit.ts";
import { COMMIT_SCOPE_ENV } from "./pipeline-commit.ts";
import type { AgentName, SessionPhase, SessionSpec } from "./role-context.ts";
import { runtimeBoundary } from "./runtime-policy.ts";
import type { JobTask } from "./task-request.ts";

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

// A stage's access to its job's checkout: the code's (repo/), whose docs are
// in repo/docs/.
interface CheckoutAccess {
  repo: Access;
}

// What a stage job declares about itself for a sandbox: its role, the
// folder it works in, its access to the checkout there (what its committing
// sessions may commit; a read-only session, such as the reviewer's final
// security review, commits nothing), the names of its sessions' env, and its
// network.
interface Boundary {
  role: JobRole;
  checkout: string;
  access: CheckoutAccess;
  env: string[];
  network: readonly string[];
  runtime: ReturnType<typeof runtimeBoundary>;
}

// The role each stage's job runs as (Reimagined-Pipeline): the author only
// reads; the implementor and the hardener write; merge holds the
// credentials for Land and Completion, and its one model session, the
// read-only security review, never gets them.
const STAGE_ROLES: Readonly<Record<Stage, JobRole>> = {
  author: "reader",
  implement: "writer",
  review: "writer",
  merge: "merger",
};

// The access profile each task job runs as (`least-privilege-per-task`):
// Sync pushes the issue's branch; Integration only reads and checks.
const TASK_ROLES: Readonly<Record<JobTask, JobRole>> = {
  sync: "writer",
  integration: "reader",
};

// Each stage's access to the issue's code checkout, which its committing
// sessions get: the author only reads it; the implementor writes it and
// the hardener hardens it. Merge commits nothing: its security review
// reads.
const STAGE_CODE_ACCESS: Readonly<Record<Stage, Access>> = {
  author: "read",
  implement: "write",
  review: "write",
  merge: "read",
};

// Each task's access to the code checkout: Sync's resolver resolves the
// rebase there; Integration checks a detached copy and writes nothing.
const TASK_CODE_ACCESS: Readonly<Record<JobTask, Access>> = {
  sync: "write",
  integration: "read",
};

// The role a job runs as: its task's, when it runs one, else its stage's.
function jobRoleOf(stage: Stage, task: JobTask | null = null): JobRole {
  if (task !== null) {
    return TASK_ROLES[task];
  }
  return STAGE_ROLES[stage];
}

// A job's access to its code checkout: its task's, else its stage's.
function codeAccessOf(stage: Stage, task: JobTask | null = null): Access {
  if (task !== null) {
    return TASK_CODE_ACCESS[task];
  }
  return STAGE_CODE_ACCESS[stage];
}

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
// hardens, committing, in review; and merge runs only the reviewer's
// read-only security review of the candidate. A reviewer session always
// names its phase; none reads before merge.
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
    sessions: [{ phase: "security-review", commits: false }],
  },
};

// The sessions each task job runs: Hippy's Sync resolves a stopped rebase as
// the Developer, in a fresh session; Lawd's Integration runs no model.
const TASK_AGENTS: Readonly<Record<JobTask, StageAgent>> = {
  sync: {
    agent: "issue-pipeline-implementor",
    role: "implementor",
    sessions: [{ phase: "sync", commits: true }],
  },
  integration: { agent: REVIEWER_AGENT, role: "reviewer", sessions: [] },
};

// Who performs the review stage's Hardening (two-buddies,
// hardening-stays-independent): "lawd", the installed default, runs it as the
// Reviewer agent above; "hippy" runs it as the Developer, Hippy, in a fresh
// session of the Developer's own agent and model. Either way the session
// commits only through the job and holds no token, its pushes and PR
// readiness use the development account, and only the job's recorder, the
// landing account, saves state or posts its result. Nothing selects "hippy"
// unless the job is started with `--hardening-buddy hippy`.
const HARDENING_BUDDIES = ["lawd", "hippy"] as const;

type HardeningBuddy = (typeof HARDENING_BUDDIES)[number];

const HIPPY_HARDENING: StageAgent = {
  agent: "issue-pipeline-implementor",
  role: "implementor",
  sessions: [{ phase: "hardening", commits: true }],
};

// The agent a `stage` job's sessions run as, with Hardening performed by
// `hardening`, or a task job's when it runs `task`.
function stageAgentOf(
  stage: Stage,
  hardening: HardeningBuddy,
  task: JobTask | null = null,
): StageAgent {
  if (task !== null) {
    return TASK_AGENTS[task];
  }
  if (stage === "review" && hardening === "hippy") {
    return HIPPY_HARDENING;
  }
  return STAGE_AGENTS[stage];
}

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

// Why session `spec` may not run in a `stage` job whose Hardening
// `hardening` performs, or null when it may: the stage runs only its one
// agent, and only the sessions it lists, each with
// its phase's write authority. A spec the stage has no session for, such as a
// reviewer session that names no phase, is refused, so its prompt and
// authority are never guessed.
function sessionRefusalOf(
  stage: Stage,
  spec: { agent: string } & Pick<SessionSpec, "commits" | "phase">,
  hardening: HardeningBuddy,
  task: JobTask | null = null,
): string | null {
  const allowed = stageAgentOf(stage, hardening, task);
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
  const hidden = new Set([COMMIT_SCOPE_ENV]);
  for (const settings of Object.values(roles)) {
    if (settings.tokenEnv !== undefined) {
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

// What a committing session of `stage` may commit: its code checkout as the
// stage's access allows, and the code globs, relative to the code checkout,
// it may commit there: any code path only while fresh authority permits code
// writes, else none, so a session after the code merged commits nothing.
// This scopes the commit tool, not OS filesystem access.
function commitScopeOf(
  stage: Stage,
  codeWritable: boolean,
  task: JobTask | null = null,
): PathScope {
  let access = codeAccessOf(stage, task);
  if (!codeWritable) {
    access = "read";
  }
  const allowed: string[] = [];
  if (access === "write") {
    allowed.push("**");
  }
  return { repo: { dir: JOB_REPO, access }, allowed };
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

// The boundary of issue `issue`'s `stage` job, or of its `task` job, with
// the env's names only.
function boundaryOf(
  cfg: Config,
  issue: number,
  job: { stage: Stage; task: JobTask | null },
  from: EnvSource,
): Boundary {
  const role = jobRoleOf(job.stage, job.task);
  const roles = rolesOf(cfg.jobRoles);
  return {
    role,
    checkout: paths.jobCheckout(cfg, issue, job.task ?? job.stage),
    access: { repo: codeAccessOf(job.stage, job.task) },
    env: Object.keys(agentEnvOf(roles, from)).sort(byName),
    network: roles[role].network,
    runtime: runtimeBoundary(cfg.runtime, cfg.models),
  };
}

export type {
  Boundary,
  CheckoutAccess,
  EnvSource,
  HardeningBuddy,
  JobRole,
  RoleSettings,
  Roles,
  StageAgent,
};
export {
  agentEnvOf,
  boundaryOf,
  codeAccessOf,
  commitScopeOf,
  HARDENING_BUDDIES,
  jobRoleOf,
  rolesOf,
  STAGE_AGENTS,
  STAGE_CODE_ACCESS,
  STAGE_ROLES,
  sessionRefusalOf,
  stageAgentOf,
  TASK_AGENTS,
};
