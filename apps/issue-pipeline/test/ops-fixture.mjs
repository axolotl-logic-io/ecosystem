// A pipeline root with a local origin, for tests that run the ops CLI against
// real git repos and the fake gh. opsFixture() must run before anything from
// src/ is imported, since the pipeline root is read once, on import.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { installFakeGh } from "./fake-gh.mjs";

const OPS = new URL("../src/ops.ts", import.meta.url).pathname;
const BASE = "integration";

// Runs a bash command and returns its trimmed stdout; a failure throws.
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

function writeConfig(file, extra) {
  const config = {
    repo: "o/r",
    account: "a",
    allowedUsers: ["a"],
    commands: { test: "true" },
    baseBranch: BASE,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify(config));
}

// Returns the fixture: the root, the fake gh, ask() to run one ops request,
// and git helpers for the origin, the seed clone and the issue worktrees.
async function opsFixture(name) {
  const root = fs.mkdtempSync(`/tmp/issue-pipeline-${name}-`);
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
  process.env.ISSUE_PIPELINE_ROOT = root;
  const fakeGh = installFakeGh();
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  sh(`git init -q --bare -b ${BASE} ${origin}`);
  sh(`git clone -q ${origin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(`cd ${seed} && echo base > f && git add f && git commit -qm base`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
  const config = path.join(root, "config.json");
  writeConfig(config, { cloneUrl: origin });
  const { loadConfig } = await import("../src/config.ts");
  const { ensureClone, ensureWorktree } = await import("../src/checkouts.ts");
  const cfg = loadConfig(config);
  const clone = ensureClone(cfg);

  // The raw stdout of one ops request, framed as the workflow frames it.
  function ask(request, configFile = config) {
    const body = JSON.stringify({ config: configFile, ...request });
    const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${body}\nEND_OPS_REQUEST`;
    const r = spawnSync(process.execPath, [OPS], {
      input,
      encoding: "utf8",
      env: { ISSUE_PIPELINE_ROOT: root, PATH: process.env.PATH },
    });
    if (r.status !== 0) {
      throw new Error(`ops exited ${r.status}: ${r.stderr}`);
    }
    return r.stdout;
  }

  // A config file with extra settings, such as a wiki.
  function configWith(fileName, extra) {
    const file = path.join(root, fileName);
    writeConfig(file, { cloneUrl: origin, ...extra });
    return file;
  }

  function worktree(n) {
    return path.join(root, "work", "o__r", `issue-${n}`);
  }

  // The sha of a ref on origin, or "" when it has none.
  function originRef(ref) {
    return sh(`git --git-dir ${origin} rev-parse -q --verify ${ref} || true`);
  }

  // Commits a file on the base branch through the seed clone.
  function advanceBase(file, text) {
    sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
    sh(`cd ${seed} && printf '${text}\\n' > ${file} && git add ${file}`);
    sh(`cd ${seed} && git commit -qm "base ${file}" && git push -q origin HEAD:${BASE}`);
    return originRef(BASE);
  }

  // Commits a file in an issue's worktree; returns the new head.
  function commitIn(n, file, text, message = `edit ${file}`) {
    const wt = worktree(n);
    fs.writeFileSync(path.join(wt, file), `${text}\n`);
    sh(`cd ${wt} && git add ${file} && git commit -qm "${message}"`);
    return sh(`git -C ${wt} rev-parse HEAD`);
  }

  // Brings the clone's origin/integration up to date with origin.
  function fetchClone() {
    sh(`git -C ${clone} fetch -q origin`);
  }

  // Starts an issue's branch on the current base with one commit of `file`,
  // pushed to origin; returns its head.
  function startBranch(n, file, text) {
    fetchClone();
    ensureWorktree(cfg, n);
    commitIn(n, file, text);
    return pushFrom(n);
  }

  // True while a rebase is stopped in the issue's worktree.
  function inRebase(n) {
    return ["rebase-merge", "rebase-apply"].some((dir) => {
      const where = sh(`git -C ${worktree(n)} rev-parse --git-path ${dir}`);
      return fs.existsSync(path.resolve(worktree(n), where));
    });
  }

  // The worktree's head and `git status --porcelain`.
  function worktreeState(n) {
    const wt = worktree(n);
    return {
      head: sh(`git -C ${wt} rev-parse HEAD`),
      status: sh(`git -C ${wt} status --porcelain`),
    };
  }

  // Pushes an issue's worktree head to its branch on origin, as the ops CLI
  // would (the clone's pre-push hook admits only it).
  function pushFrom(n) {
    const target = `HEAD:refs/heads/agent/issue-${n}`;
    sh(`ISSUE_PIPELINE_OPS=1 git -C ${worktree(n)} push -qf origin ${target}`);
    return originRef(`agent/issue-${n}`);
  }

  return {
    root,
    pushFrom,
    fetchClone,
    startBranch,
    inRebase,
    worktreeState,
    fakeGh,
    ask,
    configWith,
    worktree,
    originRef,
    advanceBase,
    commitIn,
    sh,
  };
}

// The stdout the ops CLI prints for a successful op's reply.
function okLine(op, reply) {
  return `${JSON.stringify({ ok: true, op, posted: 0, ...reply })}\n`;
}

// True when src/ops.ts still defines the handler itself: names the op as a
// string literal, as a Map entry does, or assigns it as `ops["x"] =` or
// `ops.x =`.
function opsSourceDefines(name) {
  const source = fs.readFileSync(OPS, "utf8");
  return (
    source.includes(`"${name}"`) ||
    source.includes(`ops.${name} =`)
  );
}

export { okLine, opsFixture, opsSourceDefines };
