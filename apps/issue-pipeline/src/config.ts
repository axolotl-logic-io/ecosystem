// A repo's pipeline config: the JSON file each request names, read with the
// defaults in config-schema.ts and checked once here, and the places on disk
// it implies.

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { hideCredentialVariable } from "./child-env.ts";
import { withoutRemovedKeys } from "./config-legacy.ts";
import { CONFIG_SCHEMA, checkRequired, DEFAULTS } from "./config-schema.ts";
import { JOB_DOCS, JOB_REPO } from "./job/layout.ts";
import { OpsError } from "./ops-error.ts";
import { expand, ROOT } from "./pipeline-root.ts";

// Branch names that are an option, a ref path, a ref expression or a name
// git refuses (git-check-ref-format), rather than one literal branch.
const UNSAFE_BRANCH =
  /^[-/.]|^refs\/|^HEAD$|^@$|\.\.|@\{|\/\/|[/.]$|\.lock$|\/\.|[\s~^:?*[\\\p{Cc}]/u;

// A stage job's own checkout of issue `issue` (#250). While an ops request
// that names it runs, the issue's worktree is `dir`, the job's code checkout,
// and its wiki checkout is `dir`'s sibling (#338); `branch` is the branch
// the caller assigned the issue, for its code and its wiki. It never comes
// from the config file.
interface JobCheckout {
  issue: number;
  dir: string;
  branch: string;
}

type Config = z.infer<typeof CONFIG_SCHEMA> & {
  slug: string;
  checkout?: JobCheckout;
};

interface WikiSettings {
  branch: string;
  dir: string;
}

const RAW = z.record(z.string(), z.unknown());

function loadConfig(configPath: string | undefined): Config {
  const file = expand(configPath ?? "");
  if (file === "" || !fs.existsSync(file)) {
    throw new OpsError(`config not found: ${String(configPath)}`);
  }
  const fromFile = RAW.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const { kept: raw, warnings } = withoutRemovedKeys({
    ...DEFAULTS,
    ...fromFile,
  });
  checkRequired(String(configPath), raw);
  for (const warning of warnings) {
    process.stderr.write(`config ${String(configPath)}: ${warning}\n`);
  }
  const parsed = CONFIG_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new OpsError(
      `config ${String(configPath)}: ${z.prettifyError(parsed.error)}`,
    );
  }
  const { checkout: _fromFile, ...data } = parsed.data;
  for (const role of Object.values(data.jobRoles ?? {})) {
    if (role?.tokenEnv !== undefined) {
      hideCredentialVariable(role.tokenEnv);
    }
  }
  return { ...data, slug: data.repo.replace("/", "__") };
}

// Public and model-facing config never exposes the operator credential path.
function publicConfig(cfg: Config): Omit<Config, "credentialsEnvFile"> {
  const { credentialsEnvFile: _hidden, ...rest } = cfg;
  return rest;
}

// The repo's GitHub wiki holds its docs and decisions (Autumn, 2026-10-13). Config
// `wiki: true` or `{ dir, branch }` enables publishing its submodule; off by default.
function wikiCfg(cfg: Config): WikiSettings | null {
  const { wiki } = cfg;
  if (wiki === undefined || wiki === null || wiki === false) {
    return null;
  }
  if (wiki === true) {
    return { branch: "master", dir: "wiki" };
  }
  return {
    branch: wiki.branch ?? "master",
    dir: wiki.dir ?? "wiki",
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
  // The branch issue `n` works on, for its code and its wiki: the one its
  // job was assigned (cfg.checkout), else the legacy `agent/issue-<n>`. A
  // branch that isn't one safe literal name, or is the configured base or
  // wiki branch, throws, so no op can push, reset or delete it as an issue's.
  branch: (cfg: Config, n: number): string => {
    let branch: string = paths.legacyBranch(n);
    if (cfg.checkout?.issue === n) {
      ({ branch } = cfg.checkout);
    }
    if (UNSAFE_BRANCH.test(branch)) {
      throw new OpsError(
        `#${n}'s branch ${JSON.stringify(branch)} is not a literal branch name`,
      );
    }
    if (branch === cfg.baseBranch || branch === wikiCfg(cfg)?.branch) {
      throw new OpsError(
        `#${n}'s branch ${JSON.stringify(branch)} is the base or wiki branch, which no issue works on`,
      );
    }
    return branch;
  },
  // The branch of an issue no caller assigned one: a state saved before
  // assignments, whose branch is null, works here.
  legacyBranch: (n: number): string => `agent/issue-${n}`,
  clone: (cfg: Config): string => path.join(ROOT, "clones", cfg.slug),
  // Stage job `stage`'s own folder for issue `n`, which holds its code
  // checkout and its wiki checkout side by side (#338).
  jobCheckout: (cfg: Config, n: number, stage: string): string =>
    path.join(ROOT, "work", cfg.slug, "jobs", `issue-${n}-${stage}`),
  // The job's code checkout, cloned from the mirror.
  jobRepo: (cfg: Config, n: number, stage: string): string =>
    path.join(paths.jobCheckout(cfg, n, stage), JOB_REPO),
  // The job's docs alias of the wiki submodule.
  jobDocs: (cfg: Config, n: number, stage: string): string =>
    path.join(paths.jobCheckout(cfg, n, stage), JOB_DOCS),
  // Where a writer session of issue `n` that runs out of room writes its
  // handoff, which the next session reads.
  // Where stage job `key` of issue `n` saves what its checkout `checkout`
  // left uncommitted, before it drops it (#369).
  droppedPatch: (
    cfg: Config,
    n: number,
    key: string,
    checkout: "repo" | "docs",
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
  // The issue's wiki checkout: in a stage job, its code checkout's sibling;
  // in a lane, a folder of its worktree.
  wiki: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return path.join(path.dirname(cfg.checkout.dir), JOB_DOCS);
    }
    return path.join(paths.worktree(cfg, n), wikiCfg(cfg)?.dir ?? "wiki");
  },
  wikiMirror: (cfg: Config): string =>
    path.join(ROOT, "work", cfg.slug, "wiki-mirror.git"),
  worktree: (cfg: Config, n: number): string => {
    if (cfg.checkout?.issue === n) {
      return cfg.checkout.dir;
    }
    return path.join(ROOT, "work", cfg.slug, `issue-${n}`);
  },
};

type Identity = "dev" | "merge";
const VARIABLES: Readonly<Record<Identity, string>> = {
  dev: "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
  merge: "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN",
};
const TOKEN = /^\S+$/u;
const NON_OWNER_PERMISSION_RANGE = 0o100;

function credential(cfg: Config, identity: Identity): string {
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

export type { Config, Identity, JobCheckout, WikiSettings };
export { credential, loadConfig, paths, publicConfig, wikiCfg, withCheckout };
