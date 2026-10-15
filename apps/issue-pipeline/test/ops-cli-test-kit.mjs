// The harness for the ops CLI tests (test/ops-*.test.mjs): a temporary
// pipeline root with a bare origin on `integration`, a config pointing at it,
// a fake gh first on PATH, and askOps(), which sends one request to
// src/ops.mjs as the workflow frames it. Times in replies and gh calls are
// replaced with TIME, so no assertion depends on the clock.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { commentLines, installFakeGh } from "./fake-gh.mjs";

const OPS = new URL("../src/ops.mjs", import.meta.url).pathname;
const ACCOUNT = "bot";
const ALLOWED = "alice";
const TIME = "<time>";
const ISO_TIME = /(?<stamp>\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?Z)/gu;
// Every label ensureLabels wants, so a sweep creates none.
const ALL_LABELS = [
  "agent:working",
  "agent:needs-info",
  "agent:split",
  "agent:merged",
];

const root = fs.mkdtempSync("/tmp/issue-pipeline-ops-cli-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

sh(
  `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null; cd seed && git config user.email a@b && git config user.name a && echo 1 > f && git add f && git commit -qm base && git push -q origin HEAD:integration`,
);

const fakeGh = installFakeGh();
const { STOPS } = await import("../src/stops.ts");
// The config as a sweep reports it. config.ts is outside #183's move.
const { loadConfig, publicConfig } = await import("../src/config.ts");
const labelNames = [...ALL_LABELS, ...STOPS.map((stop) => stop.label.name)];

// Writes a config with `extra` over the base settings and returns its path.
function configWith(extra) {
  const file = path.join(root, `config-${fs.readdirSync(root).length}.json`);
  const base = {
    repo: "o/r",
    account: ACCOUNT,
    allowedUsers: [ALLOWED],
    cloneUrl: path.join(root, "origin.git"),
    baseBranch: "integration",
    claimWaitSeconds: [0, 0],
    commands: { test: "true" },
  };
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
  return file;
}

const CONFIG = configWith({});

function publicConfigOf(file) {
  return publicConfig(loadConfig(file));
}

function normalise(value) {
  return JSON.parse(JSON.stringify(value).replace(ISO_TIME, TIME));
}

// The reply to `request`, sent with the base config unless it names one.
function askOps(request) {
  const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${JSON.stringify({ config: CONFIG, ...request })}\nEND_OPS_REQUEST`;
  const r = spawnSync(process.execPath, [OPS], {
    input,
    encoding: "utf8",
    env: { ISSUE_PIPELINE_ROOT: root, PATH: process.env.PATH, HOME: root },
  });
  if (r.status !== 0) {
    throw new Error(`ops exited ${r.status}: ${r.stderr}`);
  }
  return normalise(JSON.parse(r.stdout));
}

// Queues gh's replies, and forgets earlier calls.
function reply(replies) {
  fakeGh.reply(replies);
}

function calls() {
  return normalise(fakeGh.calls());
}

// A comment as listComments reads it.
function issueComment(id, body, login = ACCOUNT, at = "2026-10-15T01:00:00Z") {
  return { id, body, user: { login }, created_at: at, updated_at: at };
}

function stateComment(id, state) {
  return issueComment(
    id,
    `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  );
}

// gh's reply to listComments for issue `n`.
function commentsReply(n, comments) {
  return {
    when: `issues/${n}/comments?per_page`,
    stdout: commentLines(comments),
  };
}

const labelsReply = {
  when: "label list",
  stdout: JSON.stringify(labelNames.map((name) => ({ name }))),
};

// gh's calls, as fake-gh's calls() lists them.
const ghCalls = {
  listComments: (n) => [
    "api",
    "--paginate",
    `repos/o/r/issues/${n}/comments?per_page=100`,
    "--jq",
    ".[] | @json",
  ],
  post: (n, body) => [...ghCalls.postRaw(n, body), "--silent"],
  postRaw: (n, body) => [
    "api",
    "-X",
    "POST",
    `repos/o/r/issues/${n}/comments`,
    "-f",
    `body=${body}`,
  ],
  patch: (id, body) => [
    "api",
    "-X",
    "PATCH",
    `repos/o/r/issues/comments/${id}`,
    "-f",
    `body=${body}`,
    "--silent",
  ],
  label: (n, name) => [
    "api",
    "-X",
    "POST",
    `repos/o/r/issues/${n}/labels`,
    "--silent",
    "-f",
    `labels[]=${name}`,
  ],
  unlabel: (n, name) => [
    "api",
    "-X",
    "DELETE",
    `repos/o/r/issues/${n}/labels/${encodeURIComponent(name)}`,
    "--silent",
  ],
};

function stateBody(n, state) {
  return `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #${n}. The pipeline rewrites this comment; do not edit it.</sub>`;
}

const CLAIM_HEAD =
  "**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n\n";

// A claim comment by `lane` of sweep `sweep`, last edited `at`.
function claimComment(id, lane, sweep, at) {
  return issueComment(
    id,
    `${CLAIM_HEAD}Lane \`${lane}\` is claiming this issue.\n<!-- agent-pipeline:claim lane=${lane} sweep=${sweep} -->`,
    ACCOUNT,
    at,
  );
}

// The edit that closes claimComment(id, "me", "s1", …) with `why`.
function closedClaim(id, why) {
  return ghCalls.patch(
    id,
    `${CLAIM_HEAD}Lane \`me\` is claiming this issue.\n<!-- agent-pipeline:claim-closed lane=me sweep=s1 -->\n\nClosed ${TIME}: ${why}`,
  );
}

function worktree(n) {
  return path.join(root, "work", "o__r", `issue-${n}`);
}

function runDir(n) {
  return path.join(root, "runs", "o__r", `issue-${n}`);
}

export {
  ACCOUNT,
  ALLOWED,
  askOps,
  CONFIG,
  calls,
  claimComment,
  closedClaim,
  commentsReply,
  configWith,
  ghCalls,
  issueComment,
  labelsReply,
  publicConfigOf,
  reply,
  root,
  runDir,
  sh,
  stateBody,
  stateComment,
  TIME,
  worktree,
};
