// @ts-check
// Each process isolates HOME/ROOT before importing src. Every world uses a
// private local bare origin and an exact-script default-deny gh and pi.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.mjs";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "explicit-target-"));
const ROOT = path.join(HOME, "pipeline");
const BIN = path.join(HOME, "bin");
fs.mkdirSync(ROOT);
fs.mkdirSync(BIN);
const { PATH: inheritedPath = "" } = process.env;
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("GH_") ||
    key.startsWith("GITHUB_") ||
    key.startsWith("GIT_")
  ) {
    delete process.env[key];
  }
}
Object.assign(
  process.env,
  Object.fromEntries([
    ["HOME", HOME],
    ["ISSUE_PIPELINE_ROOT", ROOT],
    ["PI_CODING_AGENT_DIR", path.join(HOME, "agent")],
    ["PATH", `${BIN}${path.delimiter}${inheritedPath}`],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_ALLOW_PROTOCOL", "file"],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["GIT_AUTHOR_NAME", "pipeline test"],
    ["GIT_COMMITTER_NAME", "pipeline test"],
    ["GIT_AUTHOR_EMAIL", "pipeline@example.invalid"],
    ["GIT_COMMITTER_EMAIL", "pipeline@example.invalid"],
  ]),
);
const COMMAND_TIMEOUT_MS = 20_000;
const MODE = 0o755;
const fake = new URL("./explicit-target-fake-gh.mjs", import.meta.url).pathname;
fs.writeFileSync(
  path.join(BIN, "gh"),
  `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`,
  { mode: MODE },
);
fs.writeFileSync(
  path.join(BIN, "pi"),
  "#!/bin/sh\necho 'unexpected pi call' >&2\nexit 92\n",
  { mode: MODE },
);
process.on("exit", () => fs.rmSync(HOME, { recursive: true, force: true }));
const root = await import("../src/pipeline-root.ts");
if (root.ROOT !== ROOT || root.HOME !== HOME) {
  throw new Error("src loaded outside the isolated HOME/ROOT");
}
const { loadConfig, paths } = await import("../src/config.ts");
const { stateBody } = await import("../src/saved-state.ts");
const { newIssueState } = await import("../src/state.ts");

const ISSUE = 7;
const PR = 50;
const REPO = "example/repo";
const BASE = "integration";
const BRANCH = "agent/issue-7";
const ISSUE_DATA = {
  title: "Target",
  body: "Deliver the complete change",
  user: { login: "owner" },
};
const INPUTS = createHash("sha256")
  .update(JSON.stringify(["issue", ISSUE_DATA.title, ISSUE_DATA.body]))
  .digest("hex");
/** @param {string} dir @param {string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
/** @param {string} dir @param {string} file @param {string} text @returns {string} */
function commit(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, ["add", file]);
  git(dir, ["commit", "-qm", file]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** @param {{ concurrent?: boolean, squash?: boolean, fastForward?: boolean }} [options] */
function graph(options = {}) {
  const place = fs.mkdtempSync(path.join(HOME, "world-"));
  const origin = path.join(place, "origin.git");
  const seed = path.join(place, "seed");
  fs.mkdirSync(seed);
  git(place, ["init", "-q", "--bare", "-b", BASE, origin]);
  git(seed, ["init", "-q", "-b", BASE]);
  git(seed, ["remote", "add", "origin", origin]);
  const base = commit(seed, "base.txt", "base\n");
  git(seed, ["branch", "main"]);
  git(seed, ["checkout", "-qb", BRANCH]);
  commit(seed, "early.txt", "earlier feature commit\n");
  const head = commit(seed, "late.txt", "last feature commit\n");
  const moved = commit(seed, "moved.txt", "not authorized\n");
  git(seed, ["checkout", "-q", BASE]);
  let parent = base;
  if (options.concurrent === true) {
    parent = commit(
      seed,
      "concurrent.txt",
      "concurrent integration contribution\n",
    );
  }
  let merged = head;
  if (options.fastForward !== true) {
    if (options.squash === true) {
      git(seed, ["merge", "--squash", head]);
      git(seed, ["commit", "-qm", "legacy squash"]);
    } else {
      git(seed, ["merge", "--no-ff", "-qm", "branch merge", head]);
    }
    merged = git(seed, ["rev-parse", "HEAD"]);
  }
  // Upload all immutable objects to private fixture refs, while the target
  // still names prechecked B. The fake mutation alone advances integration.
  git(seed, [
    "push",
    "-q",
    "origin",
    `${merged}:refs/heads/fixture-result`,
    `${moved}:refs/heads/fixture-moved`,
    `${head}:refs/heads/${BRANCH}`,
    `${base}:refs/heads/${BASE}`,
    "main",
  ]);
  return { place, origin, seed, base, parent, head, moved, merged };
}

/** @param {{ concurrent?: boolean, squash?: boolean, fastForward?: boolean, baseBranch?: string }} [options] */
function world(options = {}) {
  const { place, origin, seed, base, parent, head, moved, merged } =
    graph(options);
  const file = path.join(place, "config.json");
  const slug = `fixture-${path.basename(place)}`;
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo: REPO,
      ...credentialConfig("bot"),
      allowedUsers: ["owner"],
      baseBranch: options.baseBranch ?? BASE,
      mergeConfirmation: { deadlineSeconds: 3, backoffSeconds: [1] },
      commands: { test: "true" },
    }),
  );
  const cfg = { ...loadConfig(file), slug };
  const clone = paths.clone(cfg);
  git(place, ["clone", "-q", origin, clone]);
  const wt = paths.worktree(cfg, ISSUE);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(clone, ["worktree", "add", "-q", "-b", BRANCH, wt, `origin/${BRANCH}`]);
  const revision = { code: head, inputs: INPUTS };
  /** @type {import("../src/state.ts").IssueState} */
  const state = {
    ...newIssueState(ISSUE),
    stage: /** @type {const} */ ("merge"),
    pr: PR,
    hardened: revision,
    security: {
      revision,
      commentId: 11,
      finding: null,
      candidate: { target: cfg.baseBranch, baseSha: base },
    },
    headSha: head,
    verifiedSha: head,
    flows: { code: true },
  };
  fs.writeFileSync(path.join(place, "state.json"), stateBody(ISSUE, state));
  return {
    cfg,
    place,
    origin,
    seed,
    wt,
    base,
    parent,
    head,
    moved,
    merged,
    revision,
    state,
  };
}

/** @typedef {ReturnType<typeof world>} World */

export {
  BASE,
  BRANCH,
  commit,
  git,
  HOME,
  INPUTS,
  ISSUE,
  ISSUE_DATA,
  PR,
  REPO,
  ROOT,
  world,
};
