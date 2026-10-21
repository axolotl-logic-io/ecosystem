// @ts-check
// Git's helper is per-call, non-storing and restricted to this repo; the
// repo's wiki gets no credential.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");
const { git } = await import("../src/github.ts");
const { cfg } = testConfig();
const fake = installFakeGh();
fake.reply([]);
const bin = path.join(isolatedRoot, "git-bin");
fs.mkdirSync(bin);
const EXECUTABLE = 0o755;
const REMOTE = /configured GitHub repository HTTPS remote/u;
const { PATH: previousPath = "" } = process.env;
Object.assign(
  process.env,
  Object.fromEntries([["PATH", `${bin}${path.delimiter}${previousPath}`]]),
);
fs.writeFileSync(
  path.join(bin, "git"),
  `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (!args.includes("ls-remote")) throw new Error("unsupported fake git request");
const encoded = args.find(arg => arg.startsWith("credential.helper=!"));
const identity = /^fake-pipeline-(dev|merge)--(.+)$/.exec(process.env.GH_TOKEN ?? "");
let helper = null;
if (encoded !== undefined) {
  const command = encoded.slice("credential.helper=!".length);
  const attempt = (host, target, action = "get") => spawnSync("/bin/sh", ["-c", command + " " + action], { env: process.env, input: "protocol=https\\nhost=" + host + "\\npath=" + target + "\\n\\n", encoding: "utf8" });
  const repo = attempt("github.com", "example/repo.git");
  helper = {
    repo: repo.status === 0 && repo.stdout === "username=x-access-token\\npassword=" + process.env.GH_TOKEN + "\\n",
    wiki: attempt("github.com", "example/repo.wiki.git").stdout === "",
    otherRepo: attempt("github.com", "other/repo.git").stdout === "",
    otherHost: attempt("other.example", "example/repo.git").stdout === "",
    store: attempt("github.com", "example/repo.git", "store").stdout === ""
  };
}
const hidden = ["GITHUB_TOKEN", "ISSUE_PIPELINE_DEV_GITHUB_TOKEN", "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN", "GH_DEBUG", "GIT_TRACE", "GIT_CONFIG_COUNT"];
process.stdout.write(JSON.stringify({
  identity: identity?.[1] ?? null,
  helper,
  inherited: hidden.filter(name => process.env[name] !== undefined),
  resetHelper: args.includes("credential.helper="),
  redirects: args.includes("http.followRedirects=false"),
  globalConfig: process.env.GIT_CONFIG_GLOBAL,
  prompt: process.env.GIT_TERMINAL_PROMPT
}));
`,
  { mode: EXECUTABLE },
);

/** @param {"dev" | "merge"} identity @param {string} remote @returns {Record<string, unknown>} */
function inspect(identity, remote) {
  return JSON.parse(git(cfg, identity, ["ls-remote", remote]).stdout);
}

/** @type {("dev" | "merge")[]} */
const IDENTITIES = ["dev", "merge"];
for (const identity of IDENTITIES) {
  test(`credentialed Git selects ${identity} and enforces its helper boundary`, () => {
    const {
      identity: actualIdentity,
      helper,
      inherited,
      resetHelper,
      redirects,
      globalConfig,
      prompt,
    } = inspect(identity, "https://github.com/example/repo.git");
    assert.equal(actualIdentity, identity);
    assert.deepEqual(helper, {
      repo: true,
      wiki: true,
      otherRepo: true,
      otherHost: true,
      store: true,
    });
    assert.deepEqual(inherited, []);
    assert.equal(resetHelper, true);
    assert.equal(redirects, true);
    assert.equal(globalConfig, "/dev/null");
    assert.equal(prompt, "0");
  });
}

test("local fake origins receive no credentials or helper", () => {
  const { identity, helper, inherited } = inspect(
    "dev",
    path.join(isolatedRoot, "origin.git"),
  );
  assert.equal(identity, null);
  assert.equal(helper, null);
  assert.deepEqual(inherited, []);
});

for (const remote of [
  "https://github.com/other/repo.git",
  "https://github.com/example/repo.wiki.git",
  "https://other.example/example/repo.git",
  "git@github.com:example/repo.git",
]) {
  test(`nonallowlisted Git remote refuses before transport: ${remote}`, () => {
    assert.throws(() => inspect("dev", remote), REMOTE);
  });
}
