// A buddy's trusted configuration: one JSON file that pairs a scope (an
// explicit organization and the repository configs it covers), one role or a
// validated subset of that role's task responsibilities, and one identity
// (its GitHub account, the access profiles it holds and its model choices).
// Role names carry no credentials. The file must be the operator's own and
// not writable by anyone else, and so must each repository config it names.
//
// Validation happens before any effect: unknown keys, the obsolete scheduler
// and assignment controls, a responsibility of another role, a profile no
// responsibility needs, an account that isn't the role's configured one, and
// a Land permission outside the Gatekeeper's Land responsibility and landing
// identity all refuse the file.
//
// Land authorization is only the explicit `permissions.land: true` of a
// Gatekeeper buddy, together with the repository config's own
// `permissions.land: true`; missing means refused. Passing checks or a
// result signal never grants it.
//
// Each buddy and repository pair has an authorization digest over the
// effective buddy file and the repository facts it is bound to. The digest
// is the action's own: it goes in observations and Land-attempt evidence,
// never into the shared checking policy (cfg.policyBinding). An ops request
// of a buddy action carries a BuddyEnvelope; bindBuddyAuthorization rereads
// and checks it, and assertBuddyAuthorization rereads it again at each
// privileged effect.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BuddyAuthorization, Config } from "../config.ts";
import { loadConfig } from "../config.ts";
import type { TaskId } from "../domain.ts";
import { ACCESS_PROFILE, ROLE_ID, TASK_ID } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import { RESOURCE_CAPACITY } from "../project-policy-schema.ts";
import { TASKS } from "../tasks/index.ts";
import { untrustedFile } from "../trusted-file.ts";

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const BUDDY_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 3600;
const DEFAULT_POLL_SECONDS = 60;
const MAX_STOP_POLL_SECONDS = 600;
const DEFAULT_STOP_POLL_SECONDS = 15;
const MIN_LEASE_SECONDS = 30;
const DEFAULT_LEASE_SECONDS = 300;
const MAX_CLAIM_WAIT_MS = 60_000;
const MAX_CLAIM_WAITS = 10;
// Safe Refactor is a Developer task only when the buddy names it.
const EXPLICIT_ONLY: readonly TaskId[] = ["refactor-safely"];

// The scheduler and assignment controls a buddy no longer reads, by the key
// a file might still carry, with what replaced each.
const OBSOLETE_CONTROLS: Readonly<Record<string, string>> = {
  assignments: "trusted buddy configuration grants standing permission",
  grant: "trusted buddy configuration grants standing permission",
  grantor: "trusted buddy configuration grants standing permission",
  maxJobs: "capacity is the repository's resources.modelSessions pool",
  stageCaps: "capacity is the repository's resources.modelSessions pool",
  modelSessions: "capacity is the repository's resources.modelSessions pool",
  resources: "capacity is the repository's resources.modelSessions pool",
  orchestratorIntervalSeconds: "each buddy run polls its tasks' sensors",
  takeNewWork: "work starts only from qualified start signals",
  stage: "a buddy run activates every task loop it is responsible for",
  stages: "a buddy run activates every task loop it is responsible for",
};

// Normalized, so a file names each path one way.
const ABSOLUTE_PATH = z
  .string()
  .refine((file) => path.isAbsolute(file), "must be an absolute path")
  .transform((file) => path.resolve(file));
const MODEL = z.string().min(1);

const BUDDY_CONFIG = z.strictObject({
  version: z.literal(1),
  name: z.string().regex(BUDDY_NAME),
  scope: z.strictObject({
    organization: z.string().regex(GITHUB_NAME),
    repositories: z.array(ABSOLUTE_PATH).min(1),
  }),
  role: ROLE_ID,
  responsibilities: z.array(TASK_ID).min(1).optional(),
  identity: z.strictObject({
    name: z.string().regex(BUDDY_NAME),
    account: z.strictObject({
      provider: z.literal("github"),
      login: z.string().regex(GITHUB_NAME),
    }),
    profiles: z.array(ACCESS_PROFILE).min(1),
    models: z
      .strictObject({
        author: MODEL.optional(),
        developer: MODEL.optional(),
        reviewer: MODEL.optional(),
      })
      .optional(),
  }),
  permissions: z.strictObject({ land: z.boolean() }).optional(),
  pollSeconds: z
    .int()
    .min(MIN_POLL_SECONDS)
    .max(MAX_POLL_SECONDS)
    .default(DEFAULT_POLL_SECONDS),
  stopPollSeconds: z
    .int()
    .min(1)
    .max(MAX_STOP_POLL_SECONDS)
    .default(DEFAULT_STOP_POLL_SECONDS),
  leaseSeconds: z
    .int()
    .min(MIN_LEASE_SECONDS)
    .max(MAX_POLL_SECONDS)
    .default(DEFAULT_LEASE_SECONDS),
  // Read by task apps (src/task-app/identity.ts): pauses between rereads
  // of the timeline while it doesn't yet show a start label's removal.
  claimWaitsMs: z
    .array(z.int().min(0).max(MAX_CLAIM_WAIT_MS))
    .max(MAX_CLAIM_WAITS)
    .optional(),
});

// What an ops request of a buddy action names: the trusted buddy file, the
// buddy run, the action's task and the authorization digest the runtime
// computed when it admitted the action.
const BUDDY_ENVELOPE = z.strictObject({
  config: ABSOLUTE_PATH,
  run: z.uuid(),
  task: TASK_ID,
  authorizationDigest: z.string().regex(SHA256),
});

type BuddyConfig = z.infer<typeof BUDDY_CONFIG>;
type BuddyEnvelope = z.infer<typeof BUDDY_ENVELOPE>;

// One repository in a buddy's scope: its config file, the config as the
// buddy runs it (with the identity's model choices), its trusted shared
// model-session capacity and the authorization digest of the pair.
interface BuddyRepository {
  file: string;
  cfg: Config;
  modelSessions: number;
  authorizationDigest: string;
}

// A buddy as its trusted file configures it, with the tasks it is
// responsible for, in the task registry's order.
interface LoadedBuddy {
  file: string;
  config: BuddyConfig;
  tasks: readonly TaskId[];
  repositories: readonly BuddyRepository[];
}

function refuse(file: string, reason: string): never {
  throw new OpsError(`buddy config ${file}: ${reason}`);
}

// Throws unless `file` is a regular file, not a link, that the current user
// owns and nobody else can write.
function assertTrustedFile(file: string, what: string): void {
  const problem = untrustedFile(file);
  if (problem === "unreadable") {
    refuse(file, `${what} is unreadable`);
  }
  if (problem === "shared") {
    refuse(
      file,
      `${what} must be a regular file owned by this user and writable by no one else`,
    );
  }
}

function readJson(file: string, what: string): unknown {
  assertTrustedFile(file, what);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed;
  } catch (error: unknown) {
    return refuse(file, `${what} is not JSON: ${String(error)}`);
  }
}

// Throws when `raw`, a buddy file's top-level object, still sets an
// obsolete scheduler or assignment control, or a capacity of its own: a
// buddy never sizes the repository's shared pool.
function assertNoObsoleteControls(file: string, raw: unknown): void {
  const keys = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!keys.success) {
    return;
  }
  for (const key of Object.keys(keys.data)) {
    const replacement = OBSOLETE_CONTROLS[key];
    if (replacement !== undefined) {
      refuse(file, `"${key}" is an obsolete control: ${replacement}`);
    }
  }
}

function duplicateOf<T>(items: readonly T[]): T | null {
  return items.find((item, at) => items.indexOf(item) !== at) ?? null;
}

function taskIds(): readonly TaskId[] {
  return TASK_ID.options;
}

// The tasks `config` makes the buddy responsible for, or a throw when it
// names a task of another role.
function tasksOf(file: string, config: BuddyConfig): TaskId[] {
  const named = config.responsibilities;
  if (named === undefined) {
    return taskIds().filter(
      (id) => TASKS[id].role === config.role && !EXPLICIT_ONLY.includes(id),
    );
  }
  const repeated = duplicateOf(named);
  if (repeated !== null) {
    refuse(file, `responsibility ${repeated} is listed twice`);
  }
  for (const id of named) {
    if (TASKS[id].role !== config.role) {
      refuse(file, `${id} is not a ${config.role} responsibility`);
    }
  }
  return taskIds().filter((id) => named.includes(id));
}

// Throws unless the identity holds exactly the access profiles the tasks
// need, and a Land permission sits with the Gatekeeper's Land responsibility
// and lander profile.
function assertConsistent(
  file: string,
  config: BuddyConfig,
  tasks: readonly TaskId[],
): void {
  const { profiles } = config.identity;
  const repeated = duplicateOf(profiles);
  if (repeated !== null) {
    refuse(file, `profile ${repeated} is listed twice`);
  }
  const needed = new Set(tasks.map((id) => TASKS[id].access));
  for (const profile of needed) {
    if (!profiles.includes(profile)) {
      refuse(file, `the identity lacks the ${profile} profile its tasks need`);
    }
  }
  for (const profile of profiles) {
    if (!needed.has(profile)) {
      refuse(file, `no responsibility needs the ${profile} profile`);
    }
  }
  if (duplicateOf(config.scope.repositories) !== null) {
    refuse(file, "a repository config is listed twice");
  }
  if (
    config.permissions?.land === true &&
    !(
      config.role === "gatekeeper" &&
      tasks.includes("land") &&
      profiles.includes("lander")
    )
  ) {
    refuse(
      file,
      "permissions.land needs the gatekeeper role, the land responsibility and the lander profile",
    );
  }
}

// The buddy file at `file`, validated, with its tasks.
function readBuddyFile(file: string): {
  config: BuddyConfig;
  tasks: TaskId[];
} {
  const raw = readJson(file, "the buddy config");
  assertNoObsoleteControls(file, raw);
  const parsed = BUDDY_CONFIG.safeParse(raw);
  if (!parsed.success) {
    return refuse(file, z.prettifyError(parsed.error));
  }
  const config = parsed.data;
  const tasks = tasksOf(file, config);
  assertConsistent(file, config, tasks);
  return { config, tasks };
}

// The repository's trusted shared model-session capacity
// (`resources.modelSessions`, pinned by its project policy in committed
// mode). A buddy has no default: missing or invalid refuses the buddy.
function modelSessionsOf(file: string, cfg: Config): number {
  const { resources } = cfg;
  const parsed = RESOURCE_CAPACITY.safeParse(resources);
  if (!parsed.success) {
    return refuse(
      file,
      `${cfg.repo}'s config has no valid resources.modelSessions capacity: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data.modelSessions;
}

// Throws unless the identity's account is the account the repository
// config gives the buddy's role (the dev account for a Developer, the
// landing account for a Gatekeeper) and the repository has a trusted
// model-session capacity.
function assertRepository(
  file: string,
  config: BuddyConfig,
  cfg: Config,
): void {
  modelSessionsOf(file, cfg);
  const { login } = config.identity.account;
  let account = cfg.landingAccount;
  if (config.role === "developer") {
    account = cfg.devAccount;
  }
  if (login.toLowerCase() !== account.toLowerCase()) {
    refuse(
      file,
      `the ${config.role} identity's account ${login} is not ${cfg.repo}'s configured ${config.role} account`,
    );
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]): number => Number(a > b) - Number(a < b));
    const fields = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`,
    );
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

// The digest of `config` bound to repository config `repository`.
function authorizationDigestOf(
  config: BuddyConfig,
  repository: string,
  cfg: Config,
): string {
  const bound = {
    version: 1,
    buddy: config,
    repository: {
      config: repository,
      repo: cfg.repo,
      base: cfg.baseBranch,
      devAccount: cfg.devAccount,
      landingAccount: cfg.landingAccount,
      coordination: cfg.coordination,
      land: cfg.permissions?.land === true,
    },
  };
  return createHash("sha256").update(canonical(bound)).digest("hex");
}

// The trusted repository config at `file`, loaded fresh.
function loadRepository(file: string): Config {
  assertTrustedFile(file, "the repository config");
  return loadConfig(file);
}

// The buddy configured by the trusted file `file`, with each repository in
// its scope loaded and checked against it. Throws, before any effect, on
// anything the file or a repository config doesn't settle.
function loadBuddy(file: string): LoadedBuddy {
  const resolved = path.resolve(file);
  const { config, tasks } = readBuddyFile(resolved);
  const repositories = config.scope.repositories.map(
    (repository): BuddyRepository => {
      const loaded = loadRepository(repository);
      assertRepository(resolved, config, loaded);
      const chosen = config.identity.models;
      const cfg: Config = {
        ...loaded,
        models: {
          author: chosen?.author ?? loaded.models.author,
          developer: chosen?.developer ?? loaded.models.developer,
          reviewer: chosen?.reviewer ?? loaded.models.reviewer,
        },
      };
      return {
        file: repository,
        cfg,
        modelSessions: modelSessionsOf(resolved, loaded),
        authorizationDigest: authorizationDigestOf(config, repository, loaded),
      };
    },
  );
  const repeated = duplicateOf(repositories.map(({ cfg }) => cfg.repo));
  if (repeated !== null) {
    refuse(resolved, `two repository configs name ${repeated}`);
  }
  return { file: resolved, config, tasks, repositories };
}

// Why the buddy may not Land in `cfg`'s repository, or null when its
// trusted file and the repository config both grant it.
function landRefusal(config: BuddyConfig, cfg: Config): string | null {
  if (config.permissions?.land !== true) {
    return "the buddy config grants no Land permission (permissions.land)";
  }
  if (cfg.permissions?.land !== true) {
    return `${cfg.repo}'s config grants no Land permission (permissions.land)`;
  }
  if (
    config.identity.account.login.toLowerCase() !==
    cfg.landingAccount.toLowerCase()
  ) {
    return "Land runs only under the configured landing identity";
  }
  return null;
}

// `cfg`, loaded by ops from repository config `repositoryConfig`, bound to
// the buddy action `envelope` names, after rereading and validating the
// trusted buddy file: the repository must be in its scope, the task one of
// its responsibilities, the identity the role's account, the digest the one
// the runtime admitted the action under, and for Land both permissions.
// Never touches cfg.policyBinding.
function bindBuddyAuthorization(
  cfg: Config,
  repositoryConfig: string,
  envelope: unknown,
): Config {
  const parsed = BUDDY_ENVELOPE.safeParse(envelope);
  if (!parsed.success) {
    throw new OpsError(`buddy envelope: ${z.prettifyError(parsed.error)}`);
  }
  const { config: file, run, task, authorizationDigest } = parsed.data;
  const { config, tasks } = readBuddyFile(file);
  const repository = path.resolve(repositoryConfig);
  if (!config.scope.repositories.includes(repository)) {
    refuse(file, `${repository} is not in the buddy's scope`);
  }
  assertTrustedFile(repository, "the repository config");
  assertRepository(file, config, cfg);
  if (!tasks.includes(task)) {
    refuse(file, `${task} is not one of the buddy's responsibilities`);
  }
  if (authorizationDigestOf(config, repository, cfg) !== authorizationDigest) {
    refuse(file, "the trusted configuration changed since the action began");
  }
  if (task === "land") {
    const refusal = landRefusal(config, cfg);
    if (refusal !== null) {
      refuse(file, refusal);
    }
  }
  const buddyAuthorization: BuddyAuthorization = {
    config: file,
    repository,
    organization: config.scope.organization,
    run,
    task,
    digest: authorizationDigest,
  };
  return { ...cfg, buddyAuthorization };
}

// Rereads the trusted configuration `cfg` was bound under and throws unless
// it still authorizes the same action: for ops to call at each privileged
// effect, such as each controlledMutation of a long op.
function assertBuddyAuthorization(cfg: Config): void {
  const bound = cfg.buddyAuthorization;
  if (bound === undefined) {
    throw new OpsError("no buddy authorization is bound to this request");
  }
  bindBuddyAuthorization(loadRepository(bound.repository), bound.repository, {
    config: bound.config,
    run: bound.run,
    task: bound.task,
    authorizationDigest: bound.digest,
  });
}

export type { BuddyConfig, BuddyEnvelope, BuddyRepository, LoadedBuddy };
export {
  assertBuddyAuthorization,
  BUDDY_CONFIG,
  BUDDY_ENVELOPE,
  bindBuddyAuthorization,
  landRefusal,
  loadBuddy,
};
