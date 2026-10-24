// One repository's source as a standards assessment sees it: its identity on
// GitHub, one immutable commit resolved from the requested ref, and the files
// of that commit and of every branch and tag. It reads and never writes:
// GitHub through gh's GET requests, the origin through a fetch into a
// throwaway bare repository, which has no work tree, so no repository code,
// hook or script runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { GIT_ENV } from "../git-remote.ts";
import { ghJson, git } from "../github.ts";
import { run } from "../process.ts";

// A request this assessment refuses before reading any source: the wrong
// repository, an unreadable one or a ref that names no commit.
class Refusal extends Error {}

interface Source {
  repo: string;
  archived: boolean;
  defaultBranch: string;
  sourceRef: string;
  commit: string;
  // Every file path at `commit`.
  files: readonly string[];
  // A file's text at `commit`, or null when it's missing or too large.
  read: (file: string) => string | null;
  // The file lists of every branch and tag head, for a scaffold check.
  everyRef: () => readonly (readonly string[])[];
  dispose: () => void;
}

const SLUG = /^(?<owner>[\w.-]+)\/(?<name>[\w.-]+)$/u;
const GITHUB_URL =
  /^https:\/\/github\.com\/(?<owner>[\w.-]+)\/(?<name>[\w.-]+?)(?:\.git)?\/?$/u;
const SHA = /^[0-9a-f]{40}$/u;
const UNSAFE_REF = /^-|\.\.|[\s\p{Cc}~^:?*[\\]|@\{/u;
const MAX_FILE_BYTES = 1_048_576;
const REPOSITORY = z.looseObject({
  fullName: z.string(),
  archived: z.boolean(),
  defaultBranch: z.string().min(1),
});

// OWNER/REPO from `input`, a slug or its canonical GitHub URL, or null.
function slugOf(input: string): string | null {
  const match = SLUG.exec(input) ?? GITHUB_URL.exec(input);
  if (match === null) {
    return null;
  }
  const { owner = "", name = "" } = match.groups ?? {};
  return `${owner}/${name}`;
}

// The configured repository, once `input` names it and GitHub agrees.
function identityOf(
  cfg: Config,
  input: string,
): z.infer<typeof REPOSITORY> & { repo: string } {
  const slug = slugOf(input);
  if (slug === null || slug.toLowerCase() !== cfg.repo.toLowerCase()) {
    throw new Refusal(
      `${JSON.stringify(input)} isn't the configured repository ${cfg.repo}`,
    );
  }
  const jq = "{fullName: .full_name, archived, defaultBranch: .default_branch}";
  const args = ["api", `repos/${cfg.repo}`, "--jq", jq];
  const parsed = REPOSITORY.safeParse(
    ghJson(cfg, "merge", args, { allowFail: true }),
  );
  if (!parsed.success) {
    throw new Refusal(`GitHub doesn't show ${cfg.repo} readable`);
  }
  if (parsed.data.fullName.toLowerCase() !== cfg.repo.toLowerCase()) {
    throw new Refusal(
      `GitHub names ${cfg.repo} ${parsed.data.fullName}; configure that name`,
    );
  }
  return { ...parsed.data, repo: cfg.repo };
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args], { env: GIT_ENV }).stdout;
}

function commitOf(dir: string, ref: string): string | null {
  const args = [
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ];
  const { code, stdout } = run("git", args, { env: GIT_ENV, allowFail: true });
  if (code !== 0) {
    return null;
  }
  return stdout.trim();
}

function resolved(
  dir: string,
  ref: string | null,
  defaultBranch: string,
): { sourceRef: string; commit: string } {
  let candidates = [`refs/heads/${defaultBranch}`];
  if (ref !== null) {
    if (ref === "" || UNSAFE_REF.test(ref)) {
      throw new Refusal(`ref ${JSON.stringify(ref)} isn't one literal ref`);
    }
    candidates = [`refs/heads/${ref}`, `refs/tags/${ref}`];
    if (ref.startsWith("refs/") || SHA.test(ref)) {
      candidates = [ref];
    }
  }
  for (const candidate of candidates) {
    const commit = commitOf(dir, candidate);
    if (commit !== null) {
      return { sourceRef: candidate, commit };
    }
  }
  throw new Refusal(`ref ${JSON.stringify(ref)} names no commit`);
}

function filesAt(dir: string, commit: string): string[] {
  return gitIn(dir, ["ls-tree", "-r", "-z", "--name-only", commit])
    .split("\0")
    .filter((file) => file !== "");
}

function readAt(dir: string, commit: string, file: string): string | null {
  const object = `${commit}:${file}`;
  const size = run("git", ["-C", dir, "cat-file", "-s", object], {
    env: GIT_ENV,
    allowFail: true,
  });
  if (size.code !== 0 || Number(size.stdout.trim()) > MAX_FILE_BYTES) {
    return null;
  }
  return gitIn(dir, ["cat-file", "blob", object]);
}

// The commits that every branch and tag names, annotated tags peeled.
function refHeads(dir: string): string[] {
  const { stdout } = run("git", ["-C", dir, "show-ref", "--heads", "--tags"], {
    env: GIT_ENV,
    allowFail: true,
  });
  const heads = stdout
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => commitOf(dir, line.slice(line.indexOf(" ") + 1)) ?? []);
  return [...new Set(heads)];
}

// Opens `input`'s source at `ref` (the default branch when null), or throws a
// Refusal before reading anything when `input` isn't the configured repository.
function openSource(cfg: Config, input: string, ref: string | null): Source {
  const identity = identityOf(cfg, input);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "standards-source-"));
  try {
    gitIn(dir, ["init", "--quiet", "--bare"]);
    const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
    gitIn(dir, ["remote", "add", "origin", url]);
    const refspecs = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"];
    git(cfg, "merge", [
      "-C",
      dir,
      "fetch",
      "--quiet",
      "--no-tags",
      "origin",
      ...refspecs,
    ]);
    const { sourceRef, commit } = resolved(dir, ref, identity.defaultBranch);
    return {
      repo: identity.repo,
      archived: identity.archived,
      defaultBranch: identity.defaultBranch,
      sourceRef,
      commit,
      files: filesAt(dir, commit),
      read: (file: string): string | null => readAt(dir, commit, file),
      everyRef: (): string[][] =>
        refHeads(dir).map((head) => filesAt(dir, head)),
      dispose: (): void => fs.rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export type { Source };
export { openSource, Refusal };
