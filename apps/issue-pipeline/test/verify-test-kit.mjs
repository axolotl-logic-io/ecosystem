// @ts-check
// Local git repos and an ops CLI caller for the tests of the check ops (verify,
// ci-status) and of the spec writer's commit check. verifyKit(root) builds a
// bare `origin.git` whose `integration` branch holds src/a.js ("old"),
// .gitignore (node_modules), README.md and any extra files, and a clone of it at
// <root>/clones/o__r, where the ops CLI looks for repo "o/r".
// Not a test file: `node --test 'test/*.test.mjs'` doesn't run it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.mjs";

const OPS = new URL("../src/ops.ts", import.meta.url).pathname;
// The folder that holds the repo's own `typescript` package.
const MODULES = path.dirname(
  path.dirname(
    path.dirname(createRequire(import.meta.url).resolve("typescript")),
  ),
);

const SHORT_SHA_LENGTH = 8;
// What verify and the spec writer's check leave behind after every case: a
// clean worktree and no temp worktree.
const CLEAN = { status: "", temps: [] };
const TEMP_WORKTREE = /\/(?:fails-before|spec-tests-reverted)-[0-9a-f]{8} /u;

/**
 * The repos verifyKit builds, and helpers for an issue `n`'s worktree.
 * @typedef {object} VerifyKit
 * @property {string} base
 * @property {(n: number) => string} worktree
 * @property {(n: number) => string} runDir
 * @property {(n: number, sha: string) => string} logs
 * @property {(files: Files) => { n: number, sha: string }} branch
 * @property {(n: number) => void} linkTypeScript
 * @property {(n: number) => { status: string, temps: string[] }} leftovers
 */
/** @typedef {Readonly<Record<string, string | null>>} Files */

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// This process's environment with ISSUE_PIPELINE_ROOT and HOME set to
// `root`, so the ops child reads nothing from the real home.
// Environment variables are named by strings, as src/process.ts takes them.
/** @param {string} root @returns {NodeJS.ProcessEnv} */
function withRoot(root) {
  const env = new Map(Object.entries(process.env));
  env.set("ISSUE_PIPELINE_ROOT", root);
  env.set("HOME", root);
  return Object.fromEntries(env);
}

// The reply line the ops CLI printed for `request`, framed as the workflow
// frames it (opsSpec in src/workflow.js).
/** @param {string} root @param {object} request @returns {string} */
function askRaw(root, request) {
  const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${JSON.stringify(request)}\nEND_OPS_REQUEST`;
  const r = spawnSync(process.execPath, [OPS], {
    input,
    encoding: "utf8",
    env: withRoot(root),
  });
  if (r.status !== 0) {
    throw new Error(`ops exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

/** @param {string} root @param {object} request @returns {unknown} */
function ask(root, request) {
  return JSON.parse(askRaw(root, request));
}

// Writes each file of `files` (path -> text) under `dir`; null deletes one.
/** @param {string} dir @param {Files} files @returns {void} */
function writeFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    const at = path.join(dir, file);
    if (text === null) {
      fs.rmSync(at);
    } else {
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, text);
    }
  }
}

// The bare origin, a seed checkout that pushes to it, and the ops CLI's clone,
// with `extra` files in the base commit too. Returns the base commit.
/** @param {string} root @param {string} seed @param {string} clone @param {Files} extra @returns {string} */
function seedRepo(root, seed, clone, extra) {
  sh(
    `git init -q --bare -b integration ${root}/origin.git && git clone -q ${root}/origin.git ${seed} 2>/dev/null`,
  );
  sh(
    `git -C ${seed} config user.email a@b && git -C ${seed} config user.name a`,
  );
  writeFiles(seed, {
    "src/a.js": "old\n",
    ".gitignore": "node_modules\n",
    "README.md": "# r\n",
    ...extra,
  });
  sh(
    `cd ${seed} && git add -A && git commit -qm base && git push -q origin HEAD:integration`,
  );
  sh(`mkdir -p ${root}/clones && git clone -q ${root}/origin.git ${clone}`);
  return sh(`git -C ${seed} rev-parse HEAD`);
}

// Writes a config for repo o/r under `root`, with `extra` keys and the given
// commands (test defaults to `true`), and returns its path.
/** @param {string} root @param {number | string} n @param {object} commands @param {object} [extra] @returns {string} */
function writeConfig(root, n, commands, extra = {}) {
  const file = path.join(root, `config-${n}.json`);
  const cfg = {
    repo: "o/r",
    ...credentialConfig("a"),
    allowedUsers: ["a"],
    baseBranch: "integration",
    commands: { test: "true", ...commands },
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(cfg));
  return file;
}

// The repos under `root`, whose base commit also holds `extra` files.
/** @param {string} root @param {Files} [extra] @returns {VerifyKit} */
function verifyKit(root, extra = {}) {
  const seed = path.join(root, "seed");
  const clone = path.join(root, "clones", "o__r");
  const base = seedRepo(root, seed, clone, extra);
  /** @param {number} n @returns {string} */
  function worktree(n) {
    return path.join(root, "work", "o__r", `issue-${n}`);
  }
  let issues = 0;
  return {
    // The seed commit every branch starts from.
    base,
    worktree,
    runDir(n) {
      return path.join(root, "runs", "o__r", `issue-${n}`);
    },
    // Where verify keeps the logs of its run on commit `sha`.
    logs(n, sha) {
      const dir = `verify-${sha.slice(0, SHORT_SHA_LENGTH)}`;
      return path.join(root, "runs", "o__r", `issue-${n}`, dir);
    },
    // Pushes agent/issue-<n>, for the next issue number n, with `files`
    // changed in one commit (an empty one for no files), checks it out at the
    // issue's worktree and returns n and the commit.
    branch(files) {
      issues += 1;
      const n = issues;
      const branch = `agent/issue-${n}`;
      sh(`git -C ${seed} checkout -q -b ${branch} ${base}`);
      writeFiles(seed, files);
      sh(
        `cd ${seed} && git add -A && git commit -q --allow-empty -m "issue ${n}" && git push -q origin ${branch}`,
      );
      sh(
        `git -C ${clone} fetch -q origin && git -C ${clone} worktree add -q -b ${branch} ${worktree(n)} origin/${branch}`,
      );
      return { n, sha: sh(`git -C ${seed} rev-parse HEAD`) };
    },
    // Lets the comment-only check find `typescript` from the worktree. The link
    // is git-ignored, so the worktree stays clean.
    linkTypeScript(n) {
      fs.symlinkSync(MODULES, path.join(worktree(n), "node_modules"));
    },
    // What verify leaves behind: the worktree's status and any temp worktree.
    leftovers(n) {
      const status = sh(`git -C ${worktree(n)} status --porcelain`);
      const temps = sh(`git -C ${worktree(n)} worktree list`)
        .split("\n")
        .filter((line) => TEMP_WORKTREE.test(line));
      return { status, temps };
    },
  };
}

export { ask, askRaw, CLEAN, sh, verifyKit, writeConfig };
