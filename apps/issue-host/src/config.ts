// A repo's pipeline config: the JSON file each request names, read with the
// defaults in config-schema.ts and checked once here, and the places on disk
// it implies.

import fs from "node:fs";
import path from "node:path";
import { hideCredentialVariable } from "@ecosystem/task-runtime/child-env";
import { readCredential } from "@ecosystem/task-runtime/credentials";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import {
  computePolicyBinding,
  resolveProjectSettings,
} from "@ecosystem/task-runtime/project-policy";
import type { ProjectPolicyBinding } from "@ecosystem/task-runtime/project-policy-schema";
import { z } from "zod";
import { CONFIG_SCHEMA, checkRequired, DEFAULTS } from "./config-schema.ts";
import { expand, ROOT } from "./host-paths.ts";
import { JOB_REPO } from "./job/layout.ts";
import type { RunResult } from "./process.ts";
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

type Config = z.infer<typeof CONFIG_SCHEMA> & {
  slug: string;
  // Verified task app transport, supplied in memory, never from JSON.
  gitAccount?: { account: string; env: ReadonlyMap<string, string> };
  policyBinding?: ProjectPolicyBinding;
  checkout?: JobCheckout;
  mutation?: (write: () => RunResult, intent: WriteIntent) => RunResult;
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
    gitAccount: _gitAccount,
    checkout: _fromFile,
    execution: _execution,
    mutation: _mutation,
    grant: _grant,
    buddyAuthorization: _buddyAuthorization,
    ...data
  } = parsed.data;
  for (const settings of Object.values(data.jobRoles ?? {})) {
    if (settings?.tokenEnv !== undefined) {
      hideCredentialVariable(settings.tokenEnv);
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
const CREDENTIAL_VARIABLES: Readonly<Record<Account, string>> = {
  dev: "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
  landing: "ISSUE_PIPELINE_LANDING_GITHUB_TOKEN",
};

function credential(cfg: Config, identity: Account): string {
  return readCredential(
    cfg.credentialsEnvFile,
    CREDENTIAL_VARIABLES[identity],
    identity,
  );
}

export type { Account, Config, JobCheckout };
export { credential, loadConfig, paths, withCheckout };
