// A repo's pipeline config: the JSON file each request names, read with the
// defaults in config-schema.ts and checked once here, and the places on disk
// it implies.

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { hideCredentialVariable } from "./child-env.ts";
import { CONFIG_SCHEMA, checkRequired, DEFAULTS } from "./config-schema.ts";
import { JOB_REPO } from "./job/layout.ts";
import { OpsError } from "./ops-error.ts";
import { expand, ROOT } from "./pipeline-root.ts";
import type { RunResult } from "./process.ts";
import {
  computePolicyBinding,
  resolveProjectSettings,
} from "./project-policy.ts";
import type { ProjectPolicyBinding } from "./project-policy-schema.ts";
import type { WriteIntent } from "./write-refusal.ts";

// Branch names that are an option, a ref path, a ref expression or a name
// git refuses (git-check-ref-format), rather than one literal branch.
const UNSAFE_BRANCH =
  /^[-/.]|^refs\/|^HEAD$|^@$|\.\.|@\{|\/\/|[/.]$|\.lock$|\/\.|[\s~^:?*[\\\p{Cc}]/u;

// An action-owned checkout of issue `issue`. During its ops request, `dir`
// supplies the issue's code checkout and `branch` its assigned work branch.
// This transport binding never comes from repository configuration.
interface JobCheckout {
  issue: number;
  dir: string;
  branch: string;
}

// The trusted buddy authorization an ops request runs under, once
// src/runtime/buddy-config.ts's bindBuddyAuthorization validated it: the
// buddy file and the repository config it was matched against, the buddy
// run and task, and the authorization digest, which is the action's own and
// never part of the shared checking policy. Internal, never loaded from JSON.
interface BuddyAuthorization {
  config: string;
  repository: string;
  run: string;
  task: string;
  digest: string;
}

type Config = z.infer<typeof CONFIG_SCHEMA> & {
  slug: string;
  policyBinding?: ProjectPolicyBinding;
  checkout?: JobCheckout;
  // Internal standalone seam only; never loaded from repository JSON.
  execution?: {
    instance: string;
    lane: string;
    issue: number;
    branch: string;
    repo: string;
    base: string;
  };
  mutation?: (write: () => RunResult, intent: WriteIntent) => RunResult;
  buddyAuthorization?: BuddyAuthorization;
};

const RAW = z.record(z.string(), z.unknown());

function loadConfig(configPath: string | undefined): Config {
  const file = expand(configPath ?? "");
  if (file === "" || !fs.existsSync(file)) {
    throw new OpsError(`config not found: ${String(configPath)}`);
  }
  const fromFile = RAW.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const raw = { ...DEFAULTS, ...resolveProjectSettings(fromFile) };
  checkRequired(String(configPath), raw);
  const parsed = CONFIG_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new OpsError(
      `config ${String(configPath)}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const {
    checkout: _fromFile,
    execution: _execution,
    mutation: _mutation,
    grant: _grant,
    buddyAuthorization: _buddyAuthorization,
    ...data
  } = parsed.data;
  for (const role of Object.values(data.jobRoles ?? {})) {
    if (role?.tokenEnv !== undefined) {
      hideCredentialVariable(role.tokenEnv);
    }
  }
  return {
    ...data,
    policyBinding: computePolicyBinding(data),
    slug: data.repo.replace("/", "__"),
  };
}

// `cfg` for one ops request: with a checkout, issue `checkout.issue` works
// in `checkout.dir`; other issues keep their worktrees.
function withCheckout(
  cfg: Config,
  checkout: JobCheckout | null | undefined,
): Config {
  if (checkout === null || checkout === undefined) {
    return cfg;
  }
  return { ...cfg, checkout };
}

const paths = {
  // The branch issue `n` works on: its action checkout's (cfg.checkout),
  // else `agent/issue-<n>`. A branch that isn't one safe literal name, or is
  // the configured base branch, throws, so no op can push, reset or delete
  // it as an issue's.
  branch: (cfg: Config, n: number): string => {
    let branch = `agent/issue-${n}`;
    if (cfg.checkout?.issue === n) {
      ({ branch } = cfg.checkout);
    }
    if (UNSAFE_BRANCH.test(branch)) {
      throw new OpsError(
        `#${n}'s branch ${JSON.stringify(branch)} is not a literal branch name`,
      );
    }
    if (branch === cfg.baseBranch) {
      throw new OpsError(
        `#${n}'s branch ${JSON.stringify(branch)} is the base branch, which no issue works on`,
      );
    }
    return branch;
  },
  clone: (cfg: Config): string => path.join(ROOT, "clones", cfg.slug),
  // Stage job `stage`'s own folder for issue `n`, which holds its code
  // checkout.
  jobCheckout: (cfg: Config, n: number, stage: string): string =>
    path.join(ROOT, "work", cfg.slug, "jobs", `issue-${n}-${stage}`),
  // The job's code checkout, cloned from the mirror.
  jobRepo: (cfg: Config, n: number, stage: string): string =>
    path.join(paths.jobCheckout(cfg, n, stage), JOB_REPO),
  // Where a writer session of issue `n` that runs out of room writes its
  // handoff, which the next session reads.
  // Where stage job `key` of issue `n` saves what its checkout `checkout`
  // left uncommitted, before it drops it (#369).
  droppedPatch: (
    cfg: Config,
    n: number,
    key: string,
    checkout: "repo",
  ): string =>
    path.join(paths.runDir(cfg, n), "dropped", `${key}-${checkout}.patch`),
  jobLog: (cfg: Config, n: number): string =>
    path.join(paths.runDir(cfg, n), "job.log"),
  // The bare code mirror that job checkouts clone.
  mirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "mirror.git"),
  runDir: (cfg: Config, n: number): string =>
    path.join(ROOT, "runs", cfg.slug, `issue-${n}`),
  // A stage job's model session for launch `key` on issue `n`, as JSONL.
  session: (cfg: Config, n: number, key: string): string =>
    path.join(paths.runDir(cfg, n), "sessions", `${key}.jsonl`),
  worktree: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return cfg.checkout.dir;
    }
    return path.join(ROOT, "work", cfg.slug, `issue-${n}`);
  },
};

type Account = "dev" | "landing";
const VARIABLES: Readonly<Record<Account, string>> = {
  dev: "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
  landing: "ISSUE_PIPELINE_LANDING_GITHUB_TOKEN",
};
const TOKEN = /^\S+$/u;
// The one field of a bound buddy's trusted file that buddyOrganization
// reads; src/runtime/buddy-config.ts owns and checks the whole file.
const BUDDY_SCOPE = z.looseObject({
  scope: z.looseObject({ organization: z.string().min(1) }),
});
const NON_OWNER_PERMISSION_RANGE = 0o100;

function credential(cfg: Config, identity: Account): string {
  let contents: string | null = null;
  try {
    const file = fs.statSync(cfg.credentialsEnvFile);
    if (!file.isFile() || file.mode % NON_OWNER_PERMISSION_RANGE !== 0) {
      throw new OpsError("credential file must be private to its owner");
    }
    contents = fs.readFileSync(cfg.credentialsEnvFile, "utf8");
  } catch (error) {
    if (error instanceof OpsError) {
      throw error;
    }
    contents = null;
  }
  if (contents === null) {
    throw new OpsError(
      `cannot read the configured ${identity} credential file`,
    );
  }
  const values = new Map(Object.entries(parseEnv(contents)));
  const selected = values.get(VARIABLES[identity]);
  if (selected === undefined || !TOKEN.test(selected)) {
    throw new OpsError(
      `credential file must set ${VARIABLES[identity]} to a nonempty token`,
    );
  }
  return selected;
}

// The organization whose active members a bound buddy action qualifies as
// people, from the buddy file bindBuddyAuthorization validated whole before
// any op ran; null when no buddy is bound or its file can't be read now.
// Ops in the tasks' import graph read it here: the buddy loader itself
// depends on the tasks.
function buddyOrganization(cfg: Config): string | null {
  const bound = cfg.buddyAuthorization;
  if (bound === undefined) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(bound.config, "utf8"));
    return BUDDY_SCOPE.parse(raw).scope.organization;
  } catch {
    return null;
  }
}

export type { Account, BuddyAuthorization, Config, JobCheckout };
export { buddyOrganization, credential, loadConfig, paths, withCheckout };
