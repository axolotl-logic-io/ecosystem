// @ts-check
// Private-bin gh never falls through to the operator's CLI. Successful fake
// ops persist their actual claim/save payload before the job can launch pi.
import fs from "node:fs";
import path from "node:path";
import { FAKE_OPS } from "./fake-rpc-pi.mjs";
import { ISSUE } from "./job-fixtures.mjs";

const JOB_OPS = `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const dir = import.meta.dirname;
const input = fs.readFileSync(0, "utf8");
const request = JSON.parse(input.split("BEGIN_OPS_REQUEST")[1].split("END_OPS_REQUEST")[0]);
const result = spawnSync(process.execPath, [dir + "/ops-inner.mjs"], { input, encoding: "utf8", env: process.env });
const lines = result.stdout.trim().split("\\n");
const json = lines.findLast(line => line.startsWith("{"));
if (json) {
  const reply = JSON.parse(json);
  if (reply.ok === true) {
    /** @type {unknown} */
  let state = null;
    if (request.op === "claim") state = reply.state;
    else if (["save-state", "release", "stop", "ask"].includes(request.op)) state = request.state;
    if (state) fs.writeFileSync(dir + "/authority-state.json", JSON.stringify(state));
    if (request.op === "start-pr") fs.writeFileSync(dir + "/authority-pr.json", JSON.stringify({ number: reply.pr, head: reply.headSha }));
  }
}
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`;

/** @param {string} root @returns {string} */
function ghScript(root) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(root + "/o__r.json", "utf8"));
const state = JSON.parse(fs.readFileSync(root + "/authority-state.json", "utf8"));
const pr = JSON.parse(fs.readFileSync(root + "/authority-pr.json", "utf8"));
const replies = JSON.parse(fs.readFileSync(root + "/replies.json", "utf8"));
const issue = replies.claim?.issue ?? ${JSON.stringify(ISSUE)};
fs.appendFileSync(root + "/gh.log", JSON.stringify(args) + "\\n");
const endpoint = args.find(arg => arg.startsWith("repos/"));
if (args[0] === "api" && endpoint === "repos/" + cfg.repo + "/issues/7/comments?per_page=100") {
  if (state) {
    process.stdout.write(JSON.stringify({ id: 1, user: { login: cfg.account }, created_at: "2026-10-18T00:00:00Z", body: "<!-- agent-pipeline:state\\n" + JSON.stringify(state) + "\\n-->" }));
  }
} else if (args[0] === "api" && endpoint === "repos/" + cfg.repo + "/issues/7") {
  process.stdout.write(JSON.stringify({ number: 7, state: "open", ...issue }));
} else if (args[0] === "api" && endpoint === "repos/" + cfg.repo + "/collaborators/" + issue.user?.login) {
  process.stdout.write("");
} else if (args[0] === "pr" && args[1] === "list" && args.includes("all") && args[args.indexOf("-R") + 1] === cfg.repo && args[args.indexOf("--head") + 1] === (state?.branch ?? "agent/issue-7")) {
  const history = [];
  if (pr !== null) history.push({ number: pr.number });
  process.stdout.write(JSON.stringify(history));
} else if (args[0] === "pr" && args[1] === "view" && pr !== null && args[2] === String(pr.number) && args[args.indexOf("-R") + 1] === cfg.repo) {
  process.stdout.write(JSON.stringify({ number: pr.number, state: "OPEN", headRefName: state.branch ?? "agent/issue-7", headRefOid: pr.head ?? "fixture-head", baseRefName: cfg.baseBranch, isCrossRepository: false, mergeCommit: null }));
} else {
  process.stderr.write("unsupported private fake gh request"); process.exit(1);
}
`;
}

/** @param {string} root @param {string} bin @param {Record<string, unknown>} replies */
function installJobAuthority(root, bin, replies) {
  const { claim } = replies;
  /** @type {unknown} */
  let state = null;
  if (typeof claim === "object" && claim !== null && "state" in claim) {
    ({ state } = claim);
  }
  fs.writeFileSync(
    path.join(root, "authority-state.json"),
    JSON.stringify(state),
  );
  let pr = null;
  if (
    typeof state === "object" &&
    state !== null &&
    "pr" in state &&
    state.pr !== null &&
    "headSha" in state
  ) {
    pr = { number: state.pr, head: state.headSha };
  }
  fs.writeFileSync(path.join(root, "authority-pr.json"), JSON.stringify(pr));
  fs.writeFileSync(path.join(root, "ops-inner.mjs"), FAKE_OPS);
  fs.writeFileSync(path.join(root, "ops.mjs"), JOB_OPS);
  fs.writeFileSync(path.join(bin, "gh"), ghScript(root), { mode: 0o755 });
}

export { installJobAuthority };
