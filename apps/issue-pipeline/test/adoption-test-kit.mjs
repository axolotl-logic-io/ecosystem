// @ts-check
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { FAKE_ADOPTION_GH, initialApi } from "./fake-adoption-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { branchOnOrigin, seedOrigins } from "./job-git-test-kit.mjs";

/** @import { IssueComment } from "../src/comments.ts" */
/** @typedef {{ number: number, state: string, merged: boolean, merged_at: string | null, merge_commit_sha: string | null, head: { ref: string, sha: string, repo: { full_name: string } }, base: { ref: string, sha: string, repo: { full_name: string } } }} Pr */
/** @typedef {{ mode: string, calls: string[][], history: unknown, pr: Pr, comments: IssueComment[], actualRepo?: string }} Api */

const MAX_BYTE = 255;
const ISSUE = 7;
const PR = 42;

const { loadConfig, paths } = await import("../src/config.ts");
const { adoptLegacy } = await import("../src/adoption.ts");
const bin = path.join(isolatedRoot, "adopt-bin");
const api = path.join(isolatedRoot, "adopt-api");
fs.mkdirSync(bin);
fs.mkdirSync(api);
fs.writeFileSync(path.join(bin, "gh"), FAKE_ADOPTION_GH, { mode: 0o755 });
const { PATH: searchPath = "" } = process.env;
Object.assign(
  process.env,
  Object.fromEntries([["PATH", `${bin}${path.delimiter}${searchPath}`]]),
);
let count = 0;
const BRANCH = "agent/issue-7";

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** @param {ReturnType<typeof fixture>} place @returns {Api} */
function readApi(place) {
  return JSON.parse(fs.readFileSync(place.apiFile, "utf8"));
}

/** @param {ReturnType<typeof fixture>} place @param {(data: Api) => void} change */
function changeApi(place, change) {
  const data = readApi(place);
  change(data);
  fs.writeFileSync(place.apiFile, JSON.stringify(data));
}

/** @param {string} tmp @param {boolean} wiki */
function localWork(tmp, wiki) {
  const origins = seedOrigins(tmp, wiki);
  const remote = branchOnOrigin(origins.origin);
  const code = path.join(tmp, "code");
  git(tmp, ["clone", "--branch", BRANCH, origins.origin, code]);
  let wikiPath;
  if (wiki) {
    git(code, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
    ]);
    wikiPath = path.join(code, "wiki");
    git(wikiPath, ["checkout", "-b", BRANCH]);
    fs.writeFileSync(path.join(wikiPath, "Home.md"), "private wiki commit\n");
    git(wikiPath, ["add", "Home.md"]);
    git(wikiPath, ["commit", "-m", "Retained private wiki"]);
  }
  return { origins, remote, code, wikiPath };
}

/** @param {string} remote */
function legacyOf(remote) {
  return {
    version: 1,
    number: ISSUE,
    stage: "done",
    pr: PR,
    headSha: remote,
    review: { verdict: "approve" },
    security: { approved: true },
    merged: { code: "historical claim, not truth" },
  };
}

/** @param {import("../src/config.ts").Config} cfg @param {string} remote */
function historicalContext(cfg, remote) {
  const runDir = paths.runDir(cfg, ISSUE);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "handoff.md"),
    "Historical approved checks; feature decisions still outstanding\n",
  );
  const legacy = legacyOf(remote);
  return { runDir, legacy };
}

/** @param {boolean} [wiki] */
function fixture(wiki = false) {
  count += 1;
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(isolatedRoot, "adopt-")),
  );
  const { origins, remote, code, wikiPath } = localWork(tmp, wiki);
  const repo = `o/adopt${count}`;
  const config = path.join(tmp, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo,
      ...credentialConfig("bot"),
      legacyAccount: "old-bot",
      allowedUsers: ["alice"],
      commands: { test: "true" },
      ...origins.config,
    }),
  );
  const cfg = loadConfig(config);
  const { runDir, legacy } = historicalContext(cfg, remote);
  const apiFile = path.join(api, `${cfg.slug}.json`);
  const data = initialApi(
    repo,
    legacy,
    { ref: BRANCH, sha: remote },
    {
      ref: cfg.baseBranch,
      sha: git(origins.origin, ["rev-parse", cfg.baseBranch]),
    },
  );
  fs.writeFileSync(apiFile, JSON.stringify(data));
  const request = {
    issue: ISSUE,
    branch: BRANCH,
    code,
    wiki: wikiPath,
    restart: "author",
  };
  return {
    tmp,
    cfg,
    config,
    code,
    wiki: wikiPath,
    origins,
    remote,
    apiFile,
    runDir,
    request,
    legacy,
    adopt: () => adoptLegacy(cfg, request),
  };
}

/** @param {string} dir */
function dirtyWork(dir) {
  fs.writeFileSync(path.join(dir, "local.txt"), "unpushed commit\n");
  git(dir, ["add", "local.txt"]);
  git(dir, ["commit", "-m", "Retained local work"]);
  fs.writeFileSync(path.join(dir, "local.txt"), "staged bytes\n");
  git(dir, ["add", "local.txt"]);
  fs.writeFileSync(path.join(dir, "local.txt"), "working bytes\n");
  fs.writeFileSync(
    path.join(dir, "binary.bin"),
    Buffer.from([0, 1, MAX_BYTE, 0]),
  );
  return {
    head: git(dir, ["rev-parse", "HEAD"]),
    status: git(dir, ["status", "--porcelain"]),
    index: git(dir, ["show", ":local.txt"]),
    working: fs.readFileSync(path.join(dir, "local.txt"), "utf8"),
  };
}

export { BRANCH, changeApi, dirtyWork, fixture, git, readApi };
