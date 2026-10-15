#!/usr/bin/env node
// Deterministic git and GitHub operations for the issue pipeline.
//
// The workflow script has no shell, so it runs this file through the
// `issue-pipeline-ops` external-cli agent. The request is one JSON object
// between BEGIN_OPS_REQUEST and END_OPS_REQUEST on stdin. The reply is one
// JSON line on stdout. Handled failures exit 0 with {"ok":false,...}; only
// crashes exit non-zero.
//
// No language model runs here. This file is the only code that reads the
// pipeline's token file.
//
// One GitHub account does everything: opens PRs, posts every agent's review,
// and merges. It may also be a human's own account. So the pipeline never
// tells its comments apart by author. Every comment it posts is signed with
// the agent role that wrote it and carries a hidden PIPELINE_MARK; a comment
// counts as the pipeline's only when it has the mark AND the account wrote it.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ROOT = process.env.ISSUE_PIPELINE_ROOT || path.join(HOME, ".pi/agent/issue-pipeline");
const STATE_MARK = "<!-- agent-pipeline:state";
const PIPELINE_MARK = /<!-- agent-pipeline:comment role=([\w.:-]+) -->/;
const PARENT_MARK = /<!-- agent-pipeline:parent (\d+) depth (\d+) -->/;
const AFTER_MARK = /<!-- agent-pipeline:after ([\d,]+) -->/;
const CLAIM_MARK = /<!-- agent-pipeline:claim lane=(\S+) sweep=(\S+) -->/;
const GH_HELPER = ["-c", "credential.https://github.com.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential"];

const LABELS = {
  working: { name: "agent:working", color: "1d76db", description: "The agent pipeline is working on this" },
  needsInfo: { name: "agent:needs-info", color: "fbca04", description: "The agent pipeline asked a question" },
  split: { name: "agent:split", color: "c5def5", description: "Split into agent sub-issues" },
  merged: { name: "agent:merged", color: "0e8a16", description: "Merged by the agent pipeline" },
};
// Every stop is a failed control: a limit or check the issue didn't pass. Each
// control has its own label, agent:stopped-<code>, and every stop posts a
// comment naming the control, the reason and how to resume. The wiki page
// Agent-Labels (axolotl-logic/project-buddy) documents
// every label; keep it in step with this table. The workflow sends
// a free-text reason; the first matching control below names it.
const STOP_PREFIX = "agent:stopped-";
const STOPS = [
  { code: "user-harm", short: "Stopped: security review found harm to users. See the stop comment.", test: /security (?:check|review) \(user-harm\)/i, control: "security: harm to users", explain: "The security review found the change would harm the app's users, for example by exposing, leaking or destroying their data." },
  { code: "rights", short: "Stopped: security review found a violation of users' rights. See the stop comment.", test: /security (?:check|review) \(rights\)/i, control: "security: users' rights", explain: "The security review found the change would violate users' rights, for example privacy, consent or access to their own data." },
  { code: "financial-harm", short: "Stopped: security review found financial harm. See the stop comment.", test: /security (?:check|review) \(financial-harm\)/i, control: "security: financial harm", explain: "The security review found the change would cause financial harm to users or the operator." },
  { code: "abuse-risk", short: "Stopped: security review found a risk of abuse. See the stop comment.", test: /security (?:check|review) \(abuse-risk\)/i, control: "security: abuse risk", explain: "The security review found the change would introduce a risk of abuse, for example missing auth or rate limits, privilege escalation or injection." },
  { code: "budget", short: "Stopped: the issue's token budget ran out. See the stop comment.", test: /token budget/i, control: "token budget", explain: "The next session would take the issue past its token budget (`issueTokenBudget`)." },
  { code: "fix-loop", short: "Stopped: a fixed review finding came back. See the stop comment.", test: /reintroduced finding|undoing each other/i, control: "recurring finding", explain: "A review finding came back after a fix had resolved it, so the fixes are undoing each other." },
  { code: "review-rounds", short: "Stopped: blocking findings remain after the fix rounds. See the stop comment.", test: /blocking findings remain/i, control: "review fix rounds", explain: "Blocking review findings were still open after the allowed fix rounds (`maxFixRounds`)." },
  { code: "checks-unrelated", short: "Stopped: failing checks look unrelated to the change. See the stop comment.", test: /look unrelated/i, control: "check fixer", explain: "The check fixer judged the failing checks unrelated to this change and did not change them." },
  { code: "check-fixes", short: "Stopped: checks still fail after the check-fix attempts. See the stop comment.", test: /checks still fail|checks did not pass within/i, control: "check fix attempts", explain: "Checks still failed after the allowed check-fix attempts (`maxCiFixes`)." },
  { code: "no-ci", short: "Stopped: CI is required and the PR has no required checks. See the stop comment.", test: /no required CI checks/i, control: "required CI", explain: "The config requires CI checks (`requireCi`), and the PR has none." },
  { code: "triage-rejected", short: "Stopped: triage judged the issue unsuitable. See the stop comment.", test: /triage rejected/i, control: "triage", explain: "Triage judged the issue unsuitable for the pipeline." },
  { code: "triage-limit", short: "Stopped: triage ran out of attempts. See the stop comment.", test: /triage ran/i, control: "triage attempts", explain: "Triage ran the allowed number of times (`maxTriages`) without a decision the pipeline can act on." },
  { code: "not-doable", short: "Stopped: the implementer can't do the issue as written. See the stop comment.", test: /could not do the issue as written/i, control: "implementer", explain: "The implementer found the issue can't be done as written." },
  { code: "too-large", short: "Stopped: too large for the implementer; split it. See the stop comment.", test: /ran out of room|did not finish within its sessions/i, control: "implementer sessions", explain: "The implementer ran out of room in its session and its one continuation; the issue needs splitting." },
  { code: "acceptance", short: "Stopped: the change doesn't fully do what the issue asks. See the stop comment.", test: /not fully resolved/i, control: "acceptance check", explain: "The acceptance verifier found the change doesn't fully do what the issue asks." },
  { code: "branch-changed", short: "Stopped: the PR branch changed outside the pipeline. See the stop comment.", test: /branch changed/i, control: "branch integrity", explain: "The PR branch changed outside the pipeline, so it stopped rather than overwrite it." },
  { code: "conflict", short: "Stopped: rebase conflicts could not be resolved. See the stop comment.", test: /conflict/i, control: "conflict resolution", explain: "Rebasing onto the base branch conflicted, and the resolver's attempts or budget ran out." },
  { code: "sync-limit", short: "Stopped: rebased too many times without merging. See the stop comment.", test: /kept moving/i, control: "rebase attempts", explain: "The base branch kept moving, and the branch was rebased the allowed number of times (`maxSyncs`) without merging." },
  { code: "push-rejected", short: "Stopped: GitHub rejected a push. See the stop comment.", test: /could not push|push.*reject/i, control: "push", explain: "GitHub rejected a push of the PR branch." },
  { code: "merge-refused", short: "Stopped: GitHub refused the merge. See the stop comment.", test: /refused the merge/i, control: "merge", explain: "GitHub refused the merge." },
  { code: "error", short: "Stopped: a pipeline step or agent session failed. See the stop comment.", test: /./, control: "step failure", explain: "A pipeline step or agent session failed." },
];
for (const s of STOPS) {
  s.label = { name: STOP_PREFIX + s.code, color: "d93f0b", description: s.short };
}
const isStopLabel = (name) => name.startsWith(STOP_PREFIX);
const stopFor = (reason) => STOPS.find((s) => s.test.test(String(reason || "")));
const PIPELINE_LABELS = Object.values(LABELS).map((l) => l.name);
const isPipelineLabel = (name) => PIPELINE_LABELS.includes(name) || isStopLabel(name);

// ---------- process helpers ----------

function expand(p) {
  return p && p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });
  const timedOut = r.error?.code === "ETIMEDOUT";
  const out = { code: r.status ?? (r.signal ? 124 : 1), stdout: r.stdout || "", stderr: r.stderr || "", timedOut };
  if (!opts.allowFail && out.code !== 0) throw new OpsError(runFailure(cmd, args, out, opts));
  return out;
}

function runFailure(cmd, args, out, opts = {}) {
  const shown = [cmd, ...args].join(" ").replace(/gh[pousr]_[A-Za-z0-9_]+/g, "<token>");
  if (out.timedOut) return `${shown} timed out after ${Math.round(opts.timeoutMs / 1000)}s: ${tail(out.stderr || out.stdout, 15)}`;
  return `${shown} exited ${out.code}: ${tail(out.stderr || out.stdout, 15)}`;
}

class OpsError extends Error {}

function tail(text, n) {
  const lines = String(text || "").trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function shell(command, cwd, logPath, timeoutMs, env = {}) {
  const r = spawnSync("bash", ["-lc", command], {
    cwd,
    env: { ...process.env, CI: "1", ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const text = `$ ${command}\n--- stdout ---\n${r.stdout || ""}\n--- stderr ---\n${r.stderr || ""}\n--- exit ${r.status ?? r.signal} ---\n`;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, text);
  }
  return { code: r.status ?? 124, log: logPath, tail: tail(`${r.stdout || ""}\n${r.stderr || ""}`, 25) };
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matchAny(globs, file) {
  return (globs || []).some((g) => globToRegExp(g).test(file));
}

// Comments that change what tools do, so editing one is a code change.
const DIRECTIVE_COMMENT = /@ts-|eslint|biome-ignore|prettier-ignore|@jsx|#__PURE__|@__PURE__|webpack|@vite-ignore|istanbul|c8 ignore|<reference/;
const SCRIPT_KINDS = { ".ts": "TS", ".mts": "TS", ".cts": "TS", ".tsx": "TSX", ".js": "JS", ".mjs": "JS", ".cjs": "JS", ".jsx": "JSX" };

// True when a JS or TS file differs between two commits only in comments and
// layout: both versions print the same with comments removed. Uses the
// worktree's own `typescript` package; without it, or for any other file
// type, a change counts as code.
// JSON with comments (tsconfig, biome.jsonc) and SQL migrations carry comments too.
// SQL counts only whole-line `--` comments, and keeps drizzle's `-->` directives.
const DATA_KINDS = { ".json": "json", ".jsonc": "json", ".json5": "json", ".sql": "sql" };

function commentOnlyChange(wt, file, fromRev, toRev) {
  const dataKind = DATA_KINDS[path.extname(file)];
  const kind = SCRIPT_KINDS[path.extname(file)];
  if (!kind && !dataKind) return false;
  let ts;
  try {
    ts = createRequire(path.join(wt, "package.json"))("typescript");
  } catch {
    return false;
  }
  const show = (rev) => {
    const r = run("git", ["-C", wt, "show", `${rev}:${file}`], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  };
  const before = show(fromRev);
  const after = show(toRev);
  if (before === null || after === null) return false;
  const diff = run("git", ["-C", wt, "diff", "-U0", fromRev, toRev, "--", file]).stdout;
  if (diff.split("\n").some((l) => /^[+-][^+-]/.test(l) && DIRECTIVE_COMMENT.test(l))) return false;
  if (dataKind === "sql") {
    const strip = (text) =>
      text
        .split("\n")
        .filter((l) => !/^\s*--(?!>)/.test(l))
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .join("\n");
    return strip(before) === strip(after);
  }
  if (dataKind === "json") {
    const parse = (text) => {
      const r = ts.parseConfigFileTextToJson(file, text);
      return r.error ? null : JSON.stringify(r.config);
    };
    const a = parse(before);
    return a !== null && a === parse(after);
  }
  const printer = ts.createPrinter({ removeComments: true });
  const print = (text) => {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind[kind]);
    if (sf.parseDiagnostics?.length) return null;
    return printer.printFile(sf);
  };
  const a = print(before);
  const b = print(after);
  return a !== null && a === b;
}

// ---------- config and paths ----------

const DEFAULTS = {
  baseBranch: "main",
  // false: lanes finish issues already in progress (agent:working, answered
  // questions) but claim no new ones (Autumn, 2026-10-14).
  takeNewWork: true,
  // Issues with any of these labels are never pipeline work, such as deploy tickets.
  skipLabels: [],
  leaseHours: 3,
  issueTokenBudget: 1000000,
  sessionTokenCap: 150000,
  maxFixRounds: 2,
  maxCiFixes: 2,
  maxSyncs: 3,
  maxConflictFixes: 2,
  maxTriages: 3,
  claimWaitSeconds: [5, 20],
  claimCandidates: 5,
  requireNewTests: true,
  requireCi: true,
  ciWaitMinutes: 30,
  commandTimeoutMinutes: 20,
  testPathGlobs: ["test/**", "tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.go"],
  nonCodePathGlobs: ["**/*.md", "docs/**"],
  lockfiles: [],
  migrations: null,
};

function loadConfig(configPath) {
  const file = expand(configPath);
  if (!file || !fs.existsSync(file)) throw new OpsError(`config not found: ${configPath}`);
  const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  for (const key of ["repo", "account"]) {
    if (!cfg[key]) throw new OpsError(`config ${configPath} is missing "${key}"`);
  }
  if (!cfg.commands || !cfg.commands.test) {
    throw new OpsError(`config ${configPath} must set commands.test; the pipeline refuses repos without a test command`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) throw new OpsError(`bad repo "${cfg.repo}"`);
  // The GitHub users whose issues the pipeline takes and whose comments its agents
  // read (Autumn, 2026-10-14). Required, so a new repo never trusts everyone by
  // default. The account is always allowed, because the pipeline opens sub-issues
  // as it. Each user must also be a collaborator (isAllowedUser).
  if (!Array.isArray(cfg.allowedUsers) || cfg.allowedUsers.length === 0) {
    throw new OpsError(`config ${configPath} must set allowedUsers, a list of GitHub usernames whose issues and comments the pipeline reads`);
  }
  for (const u of cfg.allowedUsers) {
    if (typeof u !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(u)) throw new OpsError(`bad GitHub username in allowedUsers: ${JSON.stringify(u)}`);
  }
  cfg.slug = cfg.repo.replace("/", "__");
  return cfg;
}

function publicConfig(cfg) {
  const { tokenFile, ...rest } = cfg;
  return rest;
}

// With no tokenFile, gh and git use gh's own login (the keyring), which must be `account`.
function tokenEnv(cfg) {
  if (!cfg.tokenFile) return {};
  const file = expand(cfg.tokenFile);
  if (!fs.existsSync(file)) throw new OpsError(`token file missing: ${file}`);
  return { GH_TOKEN: fs.readFileSync(file, "utf8").trim() };
}

const paths = {
  clone: (cfg) => path.join(ROOT, "clones", cfg.slug),
  worktree: (cfg, n) => path.join(ROOT, "work", cfg.slug, `issue-${n}`),
  runDir: (cfg, n) => path.join(ROOT, "runs", cfg.slug, `issue-${n}`),
  branch: (n) => `agent/issue-${n}`,
  wikiClone: (cfg) => path.join(ROOT, "clones", `${cfg.slug}.wiki`),
  wiki: (cfg, n) => path.join(ROOT, "work", cfg.slug, `issue-${n}`, wikiCfg(cfg).dir),
};

// The repo's GitHub wiki holds its docs and decisions (Autumn, 2026-10-13). Config
// `wiki: true` or `{ dir, branch }` turns it on; it is off by default.
function wikiCfg(cfg) {
  if (!cfg.wiki) return null;
  return { dir: "wiki", branch: "master", ...(typeof cfg.wiki === "object" ? cfg.wiki : {}) };
}

// ---------- GitHub helpers ----------

// A read that GitHub can safely repeat: `list`/`view` subcommands, or `gh api`
// with no method or fields (a GET). Writes aren't retried, since a 502 may
// hide one that landed.
function ghIsRead(args) {
  if (args[0] === "api") return !args.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a));
  return args[1] === "list" || args[1] === "view";
}

const GH_TRANSIENT = /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|TLS handshake timeout|i\/o timeout/i;

// A stalled GitHub request once hung a sweep for 20 minutes, until the subagent
// timeout killed it. Callers may pass a longer timeoutMs.
const GH_TIMEOUT_MS = 2 * 60 * 1000;

// Text posted to GitHub names local paths by variable, not by this machine's layout: the
// pipeline root as $ISSUE_PIPELINE_ROOT (default ~/.pi/agent/issue-pipeline), then the home
// directory as ~. Only text arguments change (body=..., --body, --title); endpoints don't.
function redactLocalPaths(text) {
  return text.split(ROOT).join("$ISSUE_PIPELINE_ROOT").split(HOME).join("~");
}

function redactGhArgs(args) {
  return args.map((a, i) =>
    a.startsWith("body=") || args[i - 1] === "--body" || args[i - 1] === "--title" ? redactLocalPaths(a) : a,
  );
}

function gh(cfg, args, opts = {}) {
  const o = { timeoutMs: GH_TIMEOUT_MS, ...opts, env: { ...tokenEnv(cfg), GH_PROMPT_DISABLED: "1" } };
  if (!ghIsRead(args)) return run("gh", redactGhArgs(args), o);
  // GitHub's API sometimes answers 502 or stalls; one failed read used to fail a whole sweep.
  for (let attempt = 1; ; attempt++) {
    const r = run("gh", args, { ...o, allowFail: true });
    if (r.code === 0 || attempt >= 4 || !(r.timedOut || GH_TRANSIENT.test(r.stderr))) {
      if (r.code === 0 || opts.allowFail) return r;
      throw new OpsError(runFailure("gh", args, r, o));
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000 * attempt);
  }
}

function ghJson(cfg, args, opts = {}) {
  const r = gh(cfg, args, opts);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

function ghLines(cfg, args, opts = {}) {
  return gh(cfg, args, opts)
    .stdout.split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function git(cfg, args, opts = {}) {
  return run("git", args, { ...opts, env: { ...tokenEnv(cfg), GIT_TERMINAL_PROMPT: "0", ISSUE_PIPELINE_OPS: "1" } });
}

// A login counts only if it is on the config's allowedUsers (or is the account)
// and is still a collaborator, so removing someone from either stops trust.
function isAllowedUser(cfg, login) {
  if (!login) return false;
  const allowed = new Set([...cfg.allowedUsers, cfg.account].map((u) => u.toLowerCase()));
  return allowed.has(login.toLowerCase()) && isCollaborator(cfg, login);
}

const collaboratorCache = new Map();
function isCollaborator(cfg, login) {
  if (!login) return false;
  if (collaboratorCache.has(login)) return collaboratorCache.get(login);
  const r = gh(cfg, ["api", `repos/${cfg.repo}/collaborators/${login}`, "--silent"], { allowFail: true });
  const ok = r.code === 0;
  collaboratorCache.set(login, ok);
  return ok;
}

function ensureLabels(cfg) {
  const existing = new Set((ghJson(cfg, ["label", "list", "-R", cfg.repo, "--limit", "500", "--json", "name"]) || []).map((l) => l.name));
  for (const l of [...Object.values(LABELS), ...STOPS.map((x) => x.label)]) {
    if (!existing.has(l.name)) {
      gh(cfg, ["label", "create", l.name, "-R", cfg.repo, "--color", l.color, "--description", l.description], { allowFail: true });
    }
  }
}

// Remove every stop label from an issue or PR, reading its labels if not given.
function clearStopLabels(cfg, number, names) {
  const have = names || (ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${number}/labels`]) || []).map((l) => l.name);
  setLabels(cfg, number, [], have.filter(isStopLabel));
}

function setLabels(cfg, number, add = [], remove = []) {
  for (const name of remove) {
    gh(cfg, ["api", "-X", "DELETE", `repos/${cfg.repo}/issues/${number}/labels/${encodeURIComponent(name)}`, "--silent"], { allowFail: true });
  }
  if (add.length) {
    const args = ["api", "-X", "POST", `repos/${cfg.repo}/issues/${number}/labels`, "--silent"];
    for (const name of add) args.push("-f", `labels[]=${name}`);
    gh(cfg, args);
  }
}

function rawComment(cfg, number, body) {
  gh(cfg, ["api", "-X", "POST", `repos/${cfg.repo}/issues/${number}/comments`, "-f", `body=${body}`, "--silent"]);
}

function roleSlug(role) {
  return String(role || "pipeline").toLowerCase().replace(/[^\w.:-]+/g, "-").replace(/^-+|-+$/g, "") || "pipeline";
}

// Header naming the agent that wrote the text, e.g.
//   **🤖 issue-pipeline · reviewer (scope)**
//   <sub>agent issue-pipeline-reader · model claude-sonnet-5-5 · run i7-review-scope-12</sub>
function signature(by) {
  const role = by?.role || "pipeline";
  const meta = [
    by?.agent ? `agent \`${by.agent}\`` : "deterministic step, no model",
    by?.model ? `model \`${by.model}\`` : null,
    by?.run ? `run \`${by.run}\`` : null,
  ].filter(Boolean);
  return `**🤖 issue-pipeline · ${role}**\n<sub>${meta.join(" · ")}</sub>\n<!-- agent-pipeline:comment role=${roleSlug(role)} -->`;
}

function signed(by, body) {
  return `${signature(by)}\n\n${body}`.slice(0, 65000);
}

function comment(cfg, number, by, body) {
  rawComment(cfg, number, signed(by, body));
}

function pipelineRole(cfg, c) {
  if (c.user?.login !== cfg.account) return null;
  if (c.body?.includes(STATE_MARK)) return "state";
  const m = c.body?.match(PIPELINE_MARK);
  return m ? m[1] : null;
}

// ---------- claim comments ----------
// Lanes may run on different machines, so they coordinate on GitHub. A lane claims
// an issue by commenting, waits a random time so that every racing lane's comment
// has landed, and proceeds only if its claim is the earliest live one. A claim is
// live until it is closed (edited to `claim-closed`) or goes leaseHours without an
// edit. The winner's claim stays live while its lane works the issue, across
// sweeps: each sweep's release edits it (touchClaim).
// It is closed when the issue leaves the pipeline: merged, stopped, asking or split.

const laneOf = (req) => String(req.lane || req.sweepId);
const leaseLane = (lease) => lease && (lease.lane || lease.sweepId);

function liveClaims(cfg, comments) {
  const maxAge = cfg.leaseHours * 3600 * 1000;
  return comments
    .filter((c) => c.user?.login === cfg.account && CLAIM_MARK.test(c.body || "") && Date.now() - Date.parse(c.updated_at || c.created_at) < maxAge)
    .map((c) => {
      const m = c.body.match(CLAIM_MARK);
      return { id: c.id, lane: m[1], sweep: m[2], body: c.body };
    })
    .sort((a, b) => a.id - b.id); // comment ids increase with creation
}

function closeClaim(cfg, claim, note) {
  const body = claim.body.replace(CLAIM_MARK, `<!-- agent-pipeline:claim-closed lane=${claim.lane} sweep=${claim.sweep} -->`) + `\n\n${note}`;
  // A claim that stays open only expires later, so a failed edit isn't fatal.
  gh(cfg, ["api", "-X", "PATCH", `repos/${cfg.repo}/issues/comments/${claim.id}`, "-f", `body=${body}`, "--silent"], { allowFail: true });
}

// Keeps this lane's claim live for another leaseHours.
function touchClaim(cfg, n, req) {
  const mine = liveClaims(cfg, listComments(cfg, n)).find((c) => c.lane === laneOf(req));
  if (!mine) return;
  const stamp = `<sub>Lane still working at ${new Date().toISOString().slice(0, 16)}Z.</sub>`;
  const body = /\n<sub>Lane still working at [^<]*<\/sub>$/.test(mine.body)
    ? mine.body.replace(/<sub>Lane still working at [^<]*<\/sub>$/, stamp)
    : `${mine.body}\n${stamp}`;
  gh(cfg, ["api", "-X", "PATCH", `repos/${cfg.repo}/issues/comments/${mine.id}`, "-f", `body=${body}`, "--silent"], { allowFail: true });
}

// The issue is leaving the pipeline, so every live claim on it is void.
function closeClaims(cfg, n, why) {
  const note = `Closed ${new Date().toISOString().slice(0, 16)}Z: ${why}`;
  for (const c of liveClaims(cfg, listComments(cfg, n))) closeClaim(cfg, c, note);
}

// Returns { won } and, when another lane holds the issue, { holder, posted }.
function raceForClaim(cfg, n, req, comments) {
  const lane = laneOf(req);
  const before = liveClaims(cfg, comments);
  // This lane already holds the issue from an earlier sweep.
  if (before.length && before[0].lane === lane) return { won: true, claimId: before[0].id, posted: false };
  // Another lane holds it; claiming would only add a comment that loses.
  if (before.length) return { won: false, holder: before[0].lane, posted: false };
  const body =
    signed({ role: "claim", run: req.sweepId }, `Lane \`${lane}\` is claiming this issue. If another lane claimed it first, this lane abandons it and takes another issue.`) +
    `\n<!-- agent-pipeline:claim lane=${lane} sweep=${req.sweepId} -->`;
  const mine = ghJson(cfg, ["api", "-X", "POST", `repos/${cfg.repo}/issues/${n}/comments`, "-f", `body=${body}`]);
  setLabels(cfg, n, [LABELS.working.name]);
  const [lo, hi] = cfg.claimWaitSeconds;
  const waited = lo + Math.random() * (hi - lo);
  sleepMs(waited * 1000);
  const after = liveClaims(cfg, listComments(cfg, n));
  if (after[0]?.id === mine.id) return { won: true, claimId: mine.id, posted: true, waited };
  // An earlier claim won, or this lane can't see its own claim yet; either way, back off.
  const holder = after[0] && after[0].id !== mine.id ? after[0].lane : null;
  const why = holder ? `lane \`${holder}\` claimed this issue first` : "this lane couldn't confirm its claim was first";
  closeClaim(cfg, { id: mine.id, lane, sweep: req.sweepId, body: mine.body || body }, `Abandoned ${new Date().toISOString().slice(0, 16)}Z: ${why}. This lane takes another issue.`);
  return { won: false, holder, posted: true, waited };
}

function listComments(cfg, number) {
  return ghLines(cfg, ["api", "--paginate", `repos/${cfg.repo}/issues/${number}/comments?per_page=100`, "--jq", ".[] | @json"]).map((s) =>
    typeof s === "string" ? JSON.parse(s) : s,
  );
}

// ---------- hidden state comment ----------

function parseStateBody(body) {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf("-->", start);
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(body.slice(start + STATE_MARK.length, end));
  } catch {
    return null;
  }
}

function readState(cfg, number, comments) {
  // Only trust a state comment written by the pipeline's account. Anyone can paste the marker.
  const mine = (comments || listComments(cfg, number)).filter((c) => c.user?.login === cfg.account && c.body?.includes(STATE_MARK));
  if (!mine.length) return { id: null, state: null };
  const c = mine[mine.length - 1];
  return { id: c.id, state: parseStateBody(c.body) };
}

function writeState(cfg, number, state) {
  const json = JSON.stringify(state).replace(/-->/g, "--\\u003e");
  const body = `**🤖 issue-pipeline · state**\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${number}. The pipeline rewrites this comment; do not edit it.</sub>`;
  if (body.length > 60000) throw new OpsError(`state for #${number} is too large (${body.length} chars)`);
  const { id } = readState(cfg, number);
  if (id) gh(cfg, ["api", "-X", "PATCH", `repos/${cfg.repo}/issues/comments/${id}`, "-f", `body=${body}`, "--silent"]);
  else rawComment(cfg, number, body);
}

function newState(number, depth) {
  return {
    version: 1,
    number,
    depth,
    stage: "triage",
    lease: null,
    pr: null,
    headSha: null,
    reviewedSha: null,
    verifiedSha: null,
    plan: null,
    allocated: 0,
    reportedTokens: 0,
    sessions: [],
    triages: 0,
    continuations: 0,
    round: 0,
    ciFixes: 0,
    syncs: 0,
    findings: [],
    resolvedHistory: [],
    questionsAt: null,
    log: [],
  };
}

// ---------- clone and worktrees ----------

function ensureClone(cfg) {
  return withCloneLock(cfg, () => ensureCloneLocked(cfg));
}

function ensureCloneLocked(cfg) {
  const clone = paths.clone(cfg);
  if (!fs.existsSync(path.join(clone, ".git"))) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(cfg, [...GH_HELPER, "clone", cfg.cloneUrl || `https://github.com/${cfg.repo}.git`, clone]);
  }
  // Authenticate git through gh, using the token from the ops environment when there is one.
  run("git", ["-C", clone, "config", "--unset-all", "credential.https://github.com.helper"], { allowFail: true });
  run("git", ["-C", clone, "config", "--add", "credential.https://github.com.helper", ""]);
  run("git", ["-C", clone, "config", "--add", "credential.https://github.com.helper", "!gh auth git-credential"]);
  run("git", ["-C", clone, "config", "user.name", cfg.gitName || cfg.account]);
  run("git", ["-C", clone, "config", "user.email", cfg.gitEmail || `${cfg.account}@users.noreply.github.com`]);
  // Agents work in worktrees of this clone. Stop them from pushing by accident;
  // only this tool pushes. (--no-verify bypasses it, so this is a guard, not a boundary.)
  const hook = path.join(clone, ".git", "hooks", "pre-push");
  fs.writeFileSync(hook, '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n');
  fs.chmodSync(hook, 0o755);
  fetchIn(cfg, clone, "--prune");
  run("git", ["-C", clone, "worktree", "prune"]);
  return clone;
}

function remoteHead(cfg, number) {
  const r = git(cfg, ["-C", paths.clone(cfg), "ls-remote", "origin", `refs/heads/${paths.branch(number)}`]);
  return r.stdout.trim().split(/\s+/)[0] || null;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// How long a sweep's pick is held before its claim must have written the lease.
const RESERVATION_MS = 15 * 60000;
const lockDepth = new Map();

// Ops for different issues run at the same time, and `git worktree add/remove`,
// `git config` and fetches write state shared by the whole clone. Two at once fail
// with "could not lock config file", so they take this lock.
function withCloneLock(cfg, fn) {
  return withLock(paths.clone(cfg) + ".lock", fn);
}

function withRepoLock(cfg, name, fn) {
  return withLock(path.join(ROOT, "runs", cfg.slug, name + ".lock"), fn);
}

// mkdir is atomic, so the directory is the lock. Reentrant within one process.
// A lock older than 10 minutes is from a dead op.
function withLock(lock, fn) {
  if (lockDepth.get(lock)) {
    lockDepth.set(lock, lockDepth.get(lock) + 1);
    try {
      return fn();
    } finally {
      lockDepth.set(lock, lockDepth.get(lock) - 1);
    }
  }
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 5 * 60000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 10 * 60000) fs.rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new OpsError(`timed out waiting for ${lock}`);
      else sleepMs(250 + Math.random() * 500);
    }
  }
  lockDepth.set(lock, 1);
  try {
    return fn();
  } finally {
    lockDepth.delete(lock);
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// A fetch writes refs shared by every worktree of the clone, so it takes the lock too.
function fetchIn(cfg, dir, ...refs) {
  return withCloneLock(cfg, () => git(cfg, ["-C", dir, "fetch", "origin", ...refs]));
}

function ensureWorktree(cfg, number) {
  return withCloneLock(cfg, () => ensureWorktreeLocked(cfg, number));
}

function ensureWorktreeLocked(cfg, number) {
  const clone = paths.clone(cfg);
  const wt = paths.worktree(cfg, number);
  const branch = paths.branch(number);
  if (fs.existsSync(path.join(wt, ".git"))) return wt;
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const remote = remoteHead(cfg, number);
  if (remote) {
    git(cfg, ["-C", clone, "fetch", "origin", `${branch}:refs/remotes/origin/${branch}`]);
    run("git", ["-C", clone, "worktree", "add", "-B", branch, wt, `origin/${branch}`]);
  } else {
    run("git", ["-C", clone, "worktree", "add", "-B", branch, wt, `origin/${cfg.baseBranch}`]);
  }
  return wt;
}

// ---------- wiki checkouts ----------
// Each issue's worktree gets the wiki at <worktree>/wiki, a worktree of a shared wiki
// clone on branch agent/issue-<n>. The code clone's info/exclude hides it from the
// code repo. Agents read it and may commit to it; prepare-review adds those commits
// to the review diff, and finishMerged pushes them to the wiki after the PR merges.
// A wiki that doesn't exist yet (GitHub creates it with the first page) is skipped.

function withWikiLock(cfg, fn) {
  return withLock(paths.wikiClone(cfg) + ".lock", fn);
}

function ensureWikiCloneLocked(cfg) {
  const clone = paths.wikiClone(cfg);
  if (!fs.existsSync(path.join(clone, ".git"))) {
    const r = git(cfg, [...GH_HELPER, "clone", wikiCfg(cfg).url || `https://github.com/${cfg.repo}.wiki.git`, clone], { allowFail: true });
    if (r.code !== 0) return null;
  }
  run("git", ["-C", clone, "config", "--unset-all", "credential.https://github.com.helper"], { allowFail: true });
  run("git", ["-C", clone, "config", "--add", "credential.https://github.com.helper", ""]);
  run("git", ["-C", clone, "config", "--add", "credential.https://github.com.helper", "!gh auth git-credential"]);
  run("git", ["-C", clone, "config", "user.name", cfg.gitName || cfg.account]);
  run("git", ["-C", clone, "config", "user.email", cfg.gitEmail || `${cfg.account}@users.noreply.github.com`]);
  const hook = path.join(clone, ".git", "hooks", "pre-push");
  fs.writeFileSync(hook, '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n');
  fs.chmodSync(hook, 0o755);
  git(cfg, ["-C", clone, "fetch", "--prune", "origin"]);
  run("git", ["-C", clone, "worktree", "prune"]);
  return clone;
}

// Returns the issue's wiki checkout, or null when the repo has no wiki. A checkout
// with no commits of its own is moved to the wiki's latest version.
function ensureWiki(cfg, n) {
  const w = wikiCfg(cfg);
  if (!w) return null;
  const exclude = path.join(paths.clone(cfg), ".git", "info", "exclude");
  const line = `/${w.dir}/`;
  if (!(fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "").split("\n").includes(line)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n${line}\n`);
  }
  return withWikiLock(cfg, () => {
    const clone = ensureWikiCloneLocked(cfg);
    if (!clone) return null;
    const dir = paths.wiki(cfg, n);
    const base = `origin/${w.branch}`;
    if (!fs.existsSync(path.join(dir, ".git"))) {
      run("git", ["-C", clone, "worktree", "add", "-B", paths.branch(n), dir, base]);
    } else if (wikiAhead(cfg, n) === 0 && !run("git", ["-C", dir, "status", "--porcelain"]).stdout.trim()) {
      run("git", ["-C", dir, "reset", "--hard", base]);
    }
    return dir;
  });
}

function wikiAhead(cfg, n) {
  const dir = paths.wiki(cfg, n);
  if (!wikiCfg(cfg) || !fs.existsSync(path.join(dir, ".git"))) return 0;
  return Number(run("git", ["-C", dir, "rev-list", "--count", `origin/${wikiCfg(cfg).branch}..HEAD`]).stdout.trim());
}

// The wiki's part of a review diff: every wiki commit the issue made so far.
function wikiDiff(cfg, n) {
  if (!wikiAhead(cfg, n)) return { diff: "", files: [] };
  const dir = paths.wiki(cfg, n);
  const range = `origin/${wikiCfg(cfg).branch}...HEAD`;
  const diff = run("git", ["-C", dir, "diff", "--stat", "--patch", range]).stdout;
  const files = run("git", ["-C", dir, "diff", "--name-only", range]).stdout.split("\n").filter(Boolean).map((f) => `${wikiCfg(cfg).dir}/${f}`);
  return { diff, files };
}

// After the PR merges: replay the issue's wiki commits on the wiki's latest version
// and push them. On a conflict the commits are saved as a patch in the run dir and
// the issue gets a comment, since the code has already merged.
function pushWiki(cfg, n) {
  if (!wikiAhead(cfg, n)) return null;
  const w = wikiCfg(cfg);
  const dir = paths.wiki(cfg, n);
  return withWikiLock(cfg, () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      git(cfg, ["-C", dir, "fetch", "origin", w.branch]);
      const r = run("git", ["-C", dir, "rebase", `origin/${w.branch}`], { allowFail: true });
      if (r.code !== 0) {
        run("git", ["-C", dir, "rebase", "--abort"], { allowFail: true });
        const patch = path.join(paths.runDir(cfg, n), "wiki-unpushed.patch");
        fs.writeFileSync(patch, run("git", ["-C", dir, "format-patch", "--stdout", `origin/${w.branch}..HEAD`]).stdout);
        comment(cfg, n, { role: "merger" }, `The wiki changes from this issue conflict with newer wiki edits, so they were not pushed. They are saved as a patch at \`${patch}\` on the pipeline's machine.`);
        return { pushed: false, patch };
      }
      const p = git(cfg, ["-C", dir, "push", "origin", `HEAD:refs/heads/${w.branch}`], { allowFail: true });
      if (p.code === 0) return { pushed: true, sha: head(dir) };
    }
    throw new OpsError("could not push the wiki changes after 3 attempts");
  });
}

function removeWorktree(cfg, number) {
  // Frees what setup made outside the worktree, such as a per-issue test database.
  // Runs in the issue's run dir, whose path names the issue. A failure is only logged.
  if (cfg.commands.teardown) {
    const dir = paths.runDir(cfg, number);
    fs.mkdirSync(dir, { recursive: true });
    shell(cfg.commands.teardown, dir, path.join(dir, "teardown.log"), 5 * 60000);
  }
  if (wikiCfg(cfg) && fs.existsSync(paths.wikiClone(cfg))) {
    withWikiLock(cfg, () => {
      run("git", ["-C", paths.wikiClone(cfg), "worktree", "remove", "--force", paths.wiki(cfg, number)], { allowFail: true });
      run("git", ["-C", paths.wikiClone(cfg), "worktree", "prune"], { allowFail: true });
      run("git", ["-C", paths.wikiClone(cfg), "branch", "-D", paths.branch(number)], { allowFail: true });
    });
  }
  withCloneLock(cfg, () => {
    const wt = paths.worktree(cfg, number);
    if (fs.existsSync(wt)) run("git", ["-C", paths.clone(cfg), "worktree", "remove", "--force", wt], { allowFail: true });
    run("git", ["-C", paths.clone(cfg), "branch", "-D", paths.branch(number)], { allowFail: true });
  });
}

function head(wt) {
  return run("git", ["-C", wt, "rev-parse", "HEAD"]).stdout.trim();
}

function assertClean(wt) {
  const s = run("git", ["-C", wt, "status", "--porcelain"]).stdout.trim();
  if (s) throw new OpsError(`worktree has uncommitted changes:\n${tail(s, 20)}`);
}

// allowEmpty lets start-pr push the branch's empty first commit. Every other push
// must change files, since that commit alone puts the branch ahead of the base.
function push(cfg, number, { allowEmpty = false } = {}) {
  const wt = paths.worktree(cfg, number);
  assertClean(wt);
  if (wikiCfg(cfg) && fs.existsSync(path.join(paths.wiki(cfg, number), ".git"))) {
    const s = run("git", ["-C", paths.wiki(cfg, number), "status", "--porcelain"]).stdout.trim();
    if (s) throw new OpsError(`the wiki checkout has uncommitted changes:\n${tail(s, 20)}`);
  }
  const ahead = Number(run("git", ["-C", wt, "rev-list", "--count", `origin/${cfg.baseBranch}..HEAD`]).stdout.trim());
  if (!ahead) throw new OpsError("branch has no commits ahead of the base branch");
  if (!allowEmpty && run("git", ["-C", wt, "diff", "--quiet", `origin/${cfg.baseBranch}...HEAD`], { allowFail: true }).code === 0) {
    throw new OpsError("branch changes no files against the base branch");
  }
  git(cfg, ["-C", wt, "push", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${paths.branch(number)}`]);
  return head(wt);
}

// ---------- issue context (allowed users' content only) ----------

function writeIssueContext(cfg, number) {
  const issue = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${number}`]);
  const comments = listComments(cfg, number);
  const parts = [`# #${number}: ${issue.title}`, "", `Author: @${issue.user.login}`, "", issue.body || "(no body)", ""];
  let dropped = 0;
  for (const c of comments) {
    const login = c.user?.login;
    const role = pipelineRole(cfg, c);
    if (role === "state" || role === "claim") continue;
    if (role) {
      parts.push(`---`, `Comment by the pipeline's ${role} agent at ${c.created_at}:`, "", c.body || "", "");
      continue;
    }
    if (!isAllowedUser(cfg, login)) {
      dropped++;
      continue;
    }
    parts.push(`---`, `Comment by @${login} (a person) at ${c.created_at}:`, "", c.body || "", "");
  }
  if (dropped) parts.push(`---`, `(${dropped} comment(s) from users not on the pipeline's allow list were withheld.)`);
  const file = path.join(paths.runDir(cfg, number), "issue.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, parts.join("\n"));
  return { file, issue, comments };
}

// ---------- operations ----------

const ops = {};

ops.sweep = (cfg, req) => {
  // Every signature and trust check assumes gh acts as `account`.
  const login = gh(cfg, ["api", "user", "--jq", ".login"]).stdout.trim();
  if (login !== cfg.account) throw new OpsError(`gh is logged in as ${login}, but the config's account is ${cfg.account}`);
  ensureLabels(cfg);
  ensureClone(cfg);
  const now = Date.now();
  const leaseMs = cfg.leaseHours * 3600 * 1000;
  const issues = ghJson(cfg, [
    "issue", "list", "-R", cfg.repo, "--state", "open", "--limit", "300",
    "--json", "number,title,author,labels,createdAt,body",
  ]) || [];
  const openNumbers = new Set(issues.map((i) => i.number));
  const candidates = [];
  const parents = [];
  let liveElsewhere = 0;
  const skipped = [];
  if (req.only) return sweepOne(cfg, req, issues, now, leaseMs);
  for (const issue of issues) {
    const labels = new Set(issue.labels.map((l) => l.name));
    if ([...labels].some(isStopLabel) || labels.has(LABELS.merged.name)) continue;
    const skipLabel = (cfg.skipLabels || []).find((l) => labels.has(l));
    if (skipLabel) {
      skipped.push({ number: issue.number, reason: "labelled " + skipLabel + " (skipLabels)" });
      continue;
    }
    const parentMatch = (issue.body || "").match(PARENT_MARK);
    const author = issue.author?.login;
    // The pipeline's account is always allowed, so its sub-issues pass this check too.
    if (!isAllowedUser(cfg, author)) {
      skipped.push({ number: issue.number, reason: "author is not on allowedUsers, or not a collaborator" });
      continue;
    }
    if (labels.has(LABELS.split.name)) {
      parents.push(issue.number);
      continue;
    }
    const depth = parentMatch ? Number(parentMatch[2]) : 0;
    const after = (issue.body || "").match(AFTER_MARK);
    if (after && after[1].split(",").some((d) => openNumbers.has(Number(d)))) continue; // An earlier sub-issue must merge first.
    if (labels.has(LABELS.working.name)) {
      const { state } = readState(cfg, issue.number);
      const leaseAt = state?.lease?.at ? Date.parse(state.lease.at) : 0;
      const live = state && state.lease && now - leaseAt < leaseMs;
      if (live && leaseLane(state.lease) !== laneOf(req)) {
        liveElsewhere++;
        continue;
      }
      // A lane finishes its own issue before it takes another.
      candidates.push({ number: issue.number, title: issue.title, kind: live ? "mine" : "resume", priority: live ? -1 : 0, createdAt: issue.createdAt, depth });
    } else if (labels.has(LABELS.needsInfo.name)) {
      const comments = listComments(cfg, issue.number);
      const { state } = readState(cfg, issue.number, comments);
      const askedAt = state?.questionsAt ? Date.parse(state.questionsAt) : 0;
      // Judge by the signature, not the author: the pipeline's account may be the person answering.
      const answered = comments.some(
        (c) => !pipelineRole(cfg, c) && Date.parse(c.created_at) > askedAt && isAllowedUser(cfg, c.user?.login),
      );
      if (answered) candidates.push({ number: issue.number, title: issue.title, kind: "answered", priority: 1, createdAt: issue.createdAt, depth });
    } else if (!issue.labels.some((l) => isPipelineLabel(l.name))) {
      if (cfg.takeNewWork === false) {
        skipped.push({ number: issue.number, reason: "new work is paused (takeNewWork: false)" });
        continue;
      }
      candidates.push({ number: issue.number, title: issue.title, kind: "new", priority: 2, createdAt: issue.createdAt, depth });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  // Each sweep works on one issue. Several lanes of one repo can run at once, on
  // one machine or several, so the number of issues in progress is the number of
  // lanes. The sweep returns a few candidates in order; the workflow claims them
  // one at a time (see raceForClaim) until a claim wins.
  const items = candidates.slice(0, cfg.claimCandidates);
  // Parents are closed by whichever sweep gets there; a local reservation keeps two
  // sweeps on this machine from closing the same parent at once.
  return withRepoLock(cfg, "sweep", () => {
    const file = path.join(ROOT, "runs", cfg.slug, "reservations.json");
    let held = {};
    try {
      held = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    const others = {};
    for (const [key, r] of Object.entries(held)) {
      if (key.startsWith("parent-") && r.sweepId !== req.sweepId && now - Date.parse(r.at) < RESERVATION_MS) others[key] = r;
    }
    const myParents = parents.filter((n) => !others["parent-" + n]);
    const mine = {};
    for (const n of myParents) mine["parent-" + n] = { sweepId: req.sweepId, at: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...others, ...mine }, null, 2));
    return {
      config: publicConfig(cfg),
      items,
      waiting: candidates.length - items.length,
      parents: myParents,
      liveElsewhere,
      skipped: skipped.length,
    };
  });
};

// A run launched for one named issue (workflow args.issue). It takes the issue
// even with an agent:stopped-* label on it: a human chose it.
// It still refuses an issue another live lane holds, and its claim races like any other.
function sweepOne(cfg, req, issues, now, leaseMs) {
  const n = Number(req.only);
  const issue = issues.find((i) => i.number === n);
  if (!issue) throw new OpsError(`#${n} is not an open issue`);
  if (!isAllowedUser(cfg, issue.author?.login)) throw new OpsError(`#${n} was opened by @${issue.author?.login}, who is not on allowedUsers or not a collaborator`);
  const labels = new Set(issue.labels.map((l) => l.name));
  const { state } = readState(cfg, n);
  const leaseAt = state?.lease?.at ? Date.parse(state.lease.at) : 0;
  if (labels.has(LABELS.working.name) && state?.lease && now - leaseAt < leaseMs && leaseLane(state.lease) !== laneOf(req)) {
    throw new OpsError(`#${n} is held by live lane ${leaseLane(state.lease)}`);
  }
  const parentMatch = (issue.body || "").match(PARENT_MARK);
  return {
    config: publicConfig(cfg),
    items: [{ number: n, title: issue.title, kind: "named", priority: 0, createdAt: issue.createdAt, depth: parentMatch ? Number(parentMatch[2]) : 0 }],
    waiting: 0,
    parents: [],
    liveElsewhere: 0,
    skipped: 0,
  };
}

ops.claim = (cfg, req) => {
  const n = req.number;
  const { file, issue, comments } = writeIssueContext(cfg, n);
  if (issue.state !== "open") throw new OpsError(`#${n} is not open`);
  const race = raceForClaim(cfg, n, req, comments);
  if (!race.won) return { lost: true, holder: race.holder, posted: race.posted, waited: race.waited };
  let { state } = readState(cfg, n, comments);
  const parentMatch = (issue.body || "").match(PARENT_MARK);
  const remote = remoteHead(cfg, n);
  const depth = parentMatch ? Number(parentMatch[2]) : 0;
  const wasNeedsInfo = issue.labels.some((l) => l.name === LABELS.needsInfo.name);
  // A start: new work, a removed agent:stopped-* label, or answered questions. A lane
  // picking up a lapsed lease is not a start; it carries on at the saved stage.
  const starting = !state || state.stage === "stopped" || state.stage === "done" || wasNeedsInfo;
  if (starting) {
    const pr = remote ? openPrFor(cfg, n) || null : null;
    state = startState(state, { n, depth, remote, pr, hasWork: !!pr && branchHasWork(cfg, n, remote), answered: wasNeedsInfo, now: new Date() });
    if (remote && fs.existsSync(path.join(paths.worktree(cfg, n), ".git"))) {
      const wt = paths.worktree(cfg, n);
      fetchIn(cfg, wt, paths.branch(n));
      run("git", ["-C", wt, "reset", "--hard", remote]);
      run("git", ["-C", wt, "clean", "-fd"]);
    }
  }
  state.lease = { lane: laneOf(req), sweepId: req.sweepId, at: new Date().toISOString() };
  const newWorktree = !fs.existsSync(path.join(paths.worktree(cfg, n), ".git"));
  const wt = ensureWorktree(cfg, n);
  const wiki = ensureWiki(cfg, n);
  // Set up a new worktree now, not only at verify, so the writer's own test runs
  // get this issue's database and ports instead of copying the shared defaults.
  // A failure here is only logged: verify runs setup again and reports it.
  if (newWorktree && cfg.commands.setup) {
    shell(cfg.commands.setup, wt, path.join(paths.runDir(cfg, n), "setup-at-claim.log"), cfg.commandTimeoutMinutes * 60000);
  }
  setLabels(cfg, n, [LABELS.working.name], [LABELS.needsInfo.name, ...issue.labels.map((l) => l.name).filter(isStopLabel)]);
  if (state.pr) {
    setLabels(cfg, state.pr, [LABELS.working.name]);
    clearStopLabels(cfg, state.pr);
  }
  writeState(cfg, n, state);
  const runDir = paths.runDir(cfg, n);
  return {
    state,
    claim: { id: race.claimId, posted: race.posted, waited: race.waited },
    remoteHead: remote,
    paths: {
      worktree: wt,
      runDir,
      issueFile: file,
      handoffFile: path.join(runDir, "handoff.md"),
      wiki,
    },
  };
};

// True when the issue's branch changes files against the base branch, so it holds
// work and not only start-pr's empty commit.
function branchHasWork(cfg, n, remote) {
  const clone = paths.clone(cfg);
  const branch = paths.branch(n);
  fetchIn(cfg, clone, `+refs/heads/${branch}:refs/remotes/origin/${branch}`, `+refs/heads/${cfg.baseBranch}:refs/remotes/origin/${cfg.baseBranch}`);
  const r = run("git", ["-C", clone, "diff", "--quiet", `origin/${cfg.baseBranch}...${remote}`], { allowFail: true });
  if (r.code > 1) throw new OpsError(runFailure("git", ["diff", "--quiet", `origin/${cfg.baseBranch}...${remote}`], r));
  return r.code === 1;
}

// The state a start begins from (Autumn, 2026-10-15). Every start finds the issue's
// open PR by its branch name. When the branch holds work, the start continues it at
// review with every limit reset, the token budget included, whatever stopped it;
// when nobody pushed since the review and no blocking finding is open, the review
// stands and it goes straight to sync. The plan and spec carry over, except after
// answered questions, which may change them. With no open PR or no work on the
// branch, it goes back to triage, and the implementer builds on the branch as it is.
function startState(state, { n, depth, remote, pr, hasWork, answered, now }) {
  const stamp = `${now.toISOString().slice(0, 16)}Z`;
  const log = state?.log || [];
  if (state && !answered && state.stage !== "stopped" && state.stage !== "done") return state;
  if (!hasWork) {
    // Answered questions keep their counters (triages); a stop or a lost state starts fresh.
    if (answered && state) return { ...state, stage: "triage", pr: pr ?? state.pr ?? null };
    const fresh = newState(n, state?.depth ?? depth);
    return { ...fresh, pr: pr ?? state?.pr ?? null, implemented: state?.implemented, headSha: remote, log };
  }
  const fresh = newState(n, state?.depth ?? depth);
  const reviewStands = !answered && !!state && remote === state.reviewedSha && !(state.findings || []).some((f) => f.status === "open");
  const stage = reviewStands ? "sync" : "review";
  const why = answered ? "answered questions" : state?.stopCode ? `the ${state.stopCode} stop` : state ? `the ${state.stage} state` : "a lost state";
  return {
    ...fresh,
    pr,
    implemented: true,
    headSha: remote,
    stage,
    ...(answered || !state ? {} : { plan: state.plan ?? null, ...(state.spec ? { spec: state.spec } : {}) }),
    ...(reviewStands ? { reviewedSha: state.reviewedSha, findings: state.findings, resolvedHistory: state.resolvedHistory || [] } : {}),
    log: [...log, `${stamp} restarted on the existing branch (PR #${pr}) at ${stage} after ${why}; limits reset`],
  };
}

// Writes state and nothing else; queued comments ride along on every op (see main).
ops["save-state"] = (cfg, req) => {
  if (req.state) writeState(cfg, req.number, req.state);
  return {};
};

ops.ask = (cfg, req) => {
  const n = req.number;
  const qs = (req.questions || []).map((q, i) => `${i + 1}. ${q}`).join("\n");
  comment(cfg, n, req.by || { role: "triage" }, `I need answers before the pipeline can work on this issue:\n\n${qs}\n\nReply in a comment. A reply from a user on the pipeline's allow list puts the issue back in the queue.`);
  const state = { ...req.state, stage: "triage", questionsAt: new Date().toISOString(), lease: null };
  writeState(cfg, n, state);
  setLabels(cfg, n, [LABELS.needsInfo.name], [LABELS.working.name]);
  closeClaims(cfg, n, "the pipeline asked questions; an answer puts the issue back in the queue.");
  return {};
};

ops.split = (cfg, req) => {
  const n = req.number;
  const depth = (req.state?.depth || 0) + 1;
  const created = [];
  for (const sub of req.subIssues || []) {
    const deps = (sub.after || []).map((j) => created[j]).filter(Boolean);
    const afterLine = deps.length ? `\nAfter ${deps.map((d) => `#${d}`).join(", ")} merges.\n<!-- agent-pipeline:after ${deps.join(",")} -->` : "";
    const body = signed(req.by || { role: "triage" }, `${sub.body}\n\nPart of #${n}.${afterLine}\n\n<!-- agent-pipeline:parent ${n} depth ${depth} -->`);
    const issue = ghJson(cfg, ["api", "-X", "POST", `repos/${cfg.repo}/issues`, "-f", `title=${sub.title}`, "-f", `body=${body}`]);
    gh(cfg, ["api", "-X", "POST", `repos/${cfg.repo}/issues/${n}/sub_issues`, "-F", `sub_issue_id=${issue.id}`, "--silent"], { allowFail: true });
    created.push(issue.number);
  }
  comment(cfg, n, req.by || { role: "triage" }, `I split this issue into ${created.map((c) => `#${c}`).join(", ")}. The pipeline closes it when they have all merged.`);
  writeState(cfg, n, { ...req.state, stage: "split", lease: null, subIssues: created });
  setLabels(cfg, n, [LABELS.split.name], [LABELS.working.name]);
  closeClaims(cfg, n, "the issue was split into sub-issues.");
  removeWorktree(cfg, n);
  return { created };
};

// Stop an issue at a failed control: label it agent:stopped-<code>, and explain
// on the issue and its PR which control stopped it, why, and how to resume.
ops.stop = (cfg, req) => {
  const n = req.number;
  const stop = (req.code && STOPS.find((x) => x.code === req.code)) || stopFor(req.reason);
  const state = { ...req.state, stage: "stopped", lease: null, stopCode: stop.code, stopReason: req.reason };
  const body = [
    `**🛑 Stopped by a control: ${stop.control}** (\`${stop.label.name}\`)`,
    "",
    stop.explain,
    "",
    `Reason: ${req.reason}`,
    req.detail ? `\n${req.detail}` : "",
    "",
    req.nextStep ||
      `To resume, fix what this names (push to the branch if you like), then remove \`${stop.label.name}\`. The next sweep continues from the PR's branch at review, with every limit reset, the token budget included.`,
  ].join("\n");
  const by = { role: "coordinator" };
  comment(cfg, n, by, body);
  if (state.pr) comment(cfg, state.pr, by, body);
  writeState(cfg, n, state);
  for (const target of [n, state.pr].filter(Boolean)) {
    clearStopLabels(cfg, target);
    setLabels(cfg, target, [stop.label.name], [LABELS.working.name]);
  }
  closeClaims(cfg, n, `the issue stopped (\`${stop.label.name}\`); removing the label puts it back in the queue.`);
  return { code: stop.code, label: stop.label.name };
};

// PRs link to their issue twice: the body starts with "Closes #N", which links the
// PR under the issue's Development section and closes it on merge, and the title
// ends with "(#N)", so the squash commit on the base branch names the issue too.
const titleFor = (n, title) => (new RegExp(`#${n}\\b`).test(title) ? title : `${title} (#${n})`);
const closesBody = (n, text) =>
  new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${n}\\b`, "i").test(text) ? text : `Closes #${n}\n\n${text}`;
const openPrFor = (cfg, n) => (ghJson(cfg, ["pr", "list", "-R", cfg.repo, "--head", paths.branch(n), "--state", "open", "--json", "number"]) || [])[0]?.number;

// Open the issue's PR as a draft as soon as triage says ready, before any code is
// written. GitHub refuses a PR with no commits, so the branch starts with an empty
// commit; the squash merge drops it. open-pr later fills in the PR and marks it ready.
ops["start-pr"] = (cfg, req) => {
  const n = req.number;
  const issue = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}`]);
  const wt = ensureWorktree(cfg, n);
  let sha = remoteHead(cfg, n);
  if (!sha) {
    assertClean(wt);
    run("git", ["-C", wt, "commit", "--allow-empty", "-m", `Start work on #${n}\n\nPipeline-Agent: coordinator`]);
    sha = push(cfg, n, { allowEmpty: true });
  }
  let pr = openPrFor(cfg, n);
  if (!pr) {
    const text = [
      "Work on this issue has started. This draft PR tracks it; the pipeline replaces this description and marks it ready for review once the change is pushed.",
      req.plan ? `\n<details><summary>Plan</summary>\n\n${req.plan}\n\n</details>` : "",
    ].join("\n");
    const url = gh(cfg, ["pr", "create", "-R", cfg.repo, "--draft", "--base", cfg.baseBranch, "--head", paths.branch(n), "--title", titleFor(n, issue.title), "--body", signed({ role: "coordinator" }, closesBody(n, text))]).stdout.trim();
    pr = Number(url.split("/").pop());
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha: sha };
};

ops["open-pr"] = (cfg, req) => {
  const n = req.number;
  const sha = push(cfg, n);
  const branch = paths.branch(n);
  const title = titleFor(n, req.title || `Fix #${n}`);
  const body = signed(req.by || { role: "implementer" }, closesBody(n, req.body || ""));
  let pr = openPrFor(cfg, n);
  if (pr) {
    // The draft from start-pr: fill it in and mark it ready for review.
    gh(cfg, ["pr", "edit", String(pr), "-R", cfg.repo, "--title", title, "--body", body]);
    gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo], { allowFail: true });
  } else {
    const url = gh(cfg, ["pr", "create", "-R", cfg.repo, "--base", cfg.baseBranch, "--head", branch, "--title", title, "--body", body]).stdout.trim();
    pr = Number(url.split("/").pop());
  }
  setLabels(cfg, pr, [LABELS.working.name], []);
  return { pr, headSha: sha };
};

ops.push = (cfg, req) => ({ headSha: push(cfg, req.number) });

ops["prepare-review"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const sha = head(wt);
  const base = run("git", ["-C", wt, "merge-base", `origin/${cfg.baseBranch}`, "HEAD"]).stdout.trim();
  // A sync rebases the branch, so an earlier reviewed commit may no longer be in its
  // history. Diffing from it would then show everything the base gained since, so
  // review the whole branch instead.
  const sinceInBranch =
    req.sinceSha && run("git", ["-C", wt, "merge-base", "--is-ancestor", req.sinceSha, sha], { allowFail: true }).code === 0;
  const from = sinceInBranch ? req.sinceSha : base;
  const diff = run("git", ["-C", wt, "diff", "--stat", "--patch", `${from}..${sha}`]).stdout;
  const allChanged = run("git", ["-C", wt, "diff", "--name-only", `${base}..${sha}`]).stdout.split("\n").filter(Boolean);
  const dir = path.join(paths.runDir(cfg, n), `review-${req.tag || "r0"}`);
  fs.mkdirSync(dir, { recursive: true });
  const diffPath = path.join(dir, "diff.patch");
  // Wiki commits come after the code diff. They are always the whole wiki change so
  // far, even in a re-review that shows only the code since the last review.
  const w = wikiDiff(cfg, n);
  const full = w.diff ? `${diff}\n\n# Wiki changes (paths under ${wikiCfg(cfg).dir}/; pushed to the wiki when the PR merges)\n\n${w.diff}` : diff;
  fs.writeFileSync(diffPath, full);
  return {
    headSha: sha,
    baseSha: base,
    diffPath,
    diffLines: full.split("\n").length,
    changedFiles: allChanged.concat(w.files),
  };
};

function rebaseInProgress(wt) {
  return ["rebase-merge", "rebase-apply"].some((d) =>
    fs.existsSync(path.resolve(wt, run("git", ["-C", wt, "rev-parse", "--git-path", d]).stdout.trim())),
  );
}

// Puts the worktree back on the pushed branch, dropping a half-done rebase.
function resetToRemote(cfg, n) {
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) run("git", ["-C", wt, "rebase", "--abort"], { allowFail: true });
  const remote = remoteHead(cfg, n);
  if (remote) run("git", ["-C", wt, "reset", "--hard", remote]);
  run("git", ["-C", wt, "clean", "-fd"]);
}

// With keepConflict, a conflicting rebase is left stopped in the worktree for a
// writer to resolve; finish-sync then checks the result and pushes it.
ops["sync-base"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) resetToRemote(cfg, n); // left over from a crashed run
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const upToDate = run("git", ["-C", wt, "merge-base", "--is-ancestor", `origin/${cfg.baseBranch}`, "HEAD"], { allowFail: true }).code === 0;
  if (upToDate) return { changed: false, conflict: false, headSha: head(wt) };
  const r = run("git", ["-C", wt, "rebase", `origin/${cfg.baseBranch}`], { allowFail: true });
  if (r.code !== 0) {
    const conflicts = run("git", ["-C", wt, "diff", "--name-only", "--diff-filter=U"], { allowFail: true }).stdout.trim();
    const kept = !!req.keepConflict && rebaseInProgress(wt);
    if (!kept) run("git", ["-C", wt, "rebase", "--abort"], { allowFail: true });
    return {
      changed: false,
      conflict: true,
      inRebase: kept,
      conflicts: conflicts.split("\n").filter(Boolean),
      baseSha: run("git", ["-C", wt, "rev-parse", `origin/${cfg.baseBranch}`]).stdout.trim(),
    };
  }
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${paths.branch(n)}`]);
  return { changed: true, conflict: false, headSha: head(wt) };
};

// After a writer resolved a kept rebase: check that the rebase finished on the
// current base with no markers left, then push. Anything else (or abort: true)
// resets the worktree to the pushed branch and reports why.
ops["finish-sync"] = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  const fail = (reason) => {
    resetToRemote(cfg, n);
    return { resolved: false, reason };
  };
  if (req.abort) return fail(req.reason || "aborted");
  if (rebaseInProgress(wt)) return fail("the rebase was not finished");
  const dirty = run("git", ["-C", wt, "status", "--porcelain"]).stdout.trim();
  if (dirty) return fail(`the worktree has uncommitted changes:\n${tail(dirty, 20)}`);
  const base = `origin/${cfg.baseBranch}`;
  if (run("git", ["-C", wt, "merge-base", "--is-ancestor", base, "HEAD"], { allowFail: true }).code !== 0) return fail(`HEAD is not based on ${base}`);
  const ahead = Number(run("git", ["-C", wt, "rev-list", "--count", `${base}..HEAD`]).stdout.trim());
  if (!ahead) return fail("the branch has no commits left after the rebase");
  const markers = run("git", ["-C", wt, "diff", `${base}...HEAD`, "-U0"]).stdout
    .split("\n")
    .filter((l) => /^\+(<{7}|>{7})( |$)/.test(l) || l === "+=======");
  if (markers.length) return fail(`conflict markers remain:\n${markers.slice(0, 10).join("\n")}`);
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", `HEAD:refs/heads/${paths.branch(n)}`]);
  return { resolved: true, headSha: head(wt) };
};

ops.verify = (cfg, req) => {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const sha = head(wt);
  const base = run("git", ["-C", wt, "merge-base", `origin/${cfg.baseBranch}`, "HEAD"]).stdout.trim();
  const changed = run("git", ["-C", wt, "diff", "--name-only", `${base}..${sha}`]).stdout.split("\n").filter(Boolean);
  const logDir = path.join(paths.runDir(cfg, n), `verify-${sha.slice(0, 8)}`);
  const timeout = cfg.commandTimeoutMinutes * 60 * 1000;
  const checks = [];
  const record = (id, pass, detail, res) => checks.push({ id, pass, detail, log: res?.log, tail: pass ? undefined : res?.tail });

  if (cfg.commands.setup) {
    const r = shell(cfg.commands.setup, wt, path.join(logDir, "setup.log"), timeout);
    record("setup", r.code === 0, `exit ${r.code}`, r);
    if (r.code !== 0) return { pass: false, headSha: sha, checks };
  }
  for (const id of ["test", "lint", "typecheck"]) {
    if (!cfg.commands[id]) continue;
    const r = shell(cfg.commands[id], wt, path.join(logDir, `${id}.log`), timeout);
    record(id, r.code === 0, `exit ${r.code}`, r);
  }

  // The new tests must fail when the non-test changes are reverted.
  const tests = changed.filter((f) => matchAny(cfg.testPathGlobs, f));
  const nonTest = changed.filter((f) => !tests.includes(f) && !matchAny(cfg.nonCodePathGlobs, f));
  // A change to comments alone has no behaviour for a test to catch.
  const commentOnly = nonTest.filter((f) => commentOnlyChange(wt, f, base, sha));
  const code = nonTest.filter((f) => !commentOnly.includes(f));
  const testsPass = checks.find((c) => c.id === "test")?.pass;
  if (req.testsOnly) {
    // A clean rebase of a head that already passed every check (workflow: testsOnly).
    // The proof that the tests catch the fix belongs to the change, which the rebase didn't touch.
    record("fails-before-fix", true, "shown before the clean rebase; skipped");
  } else if (!testsPass) {
    // A crashing test command would also "fail before the fix", so this check means nothing until tests pass.
    record("fails-before-fix", false, "not run, because the test command fails on the PR");
  } else if (!code.length) {
    record("fails-before-fix", true, commentOnly.length ? `only comments change in ${commentOnly.join(", ")}; skipped` : "no code changes; skipped");
  } else if (!tests.length) {
    record("fails-before-fix", !cfg.requireNewTests, "the change adds or edits no test files");
  } else {
    const tmp = path.join(paths.runDir(cfg, n), `fails-before-${sha.slice(0, 8)}`);
    withCloneLock(cfg, () => {
      run("git", ["-C", wt, "worktree", "remove", "--force", tmp], { allowFail: true });
      run("git", ["-C", wt, "worktree", "add", "--detach", tmp, sha]);
    });
    try {
      for (const f of code) {
        const existed = run("git", ["-C", tmp, "cat-file", "-e", `${base}:${f}`], { allowFail: true }).code === 0;
        if (existed) run("git", ["-C", tmp, "checkout", base, "--", f]);
        else fs.rmSync(path.join(tmp, f), { force: true });
      }
      if (cfg.commands.setup) shell(cfg.commands.setup, tmp, path.join(logDir, "fails-before-setup.log"), timeout);
      const r = shell(cfg.commands.test, tmp, path.join(logDir, "fails-before-test.log"), timeout);
      record("fails-before-fix", r.code !== 0, r.code !== 0 ? "tests fail with the fix reverted" : "tests still pass with the fix reverted; they do not prove the fix", r);
    } finally {
      withCloneLock(cfg, () => run("git", ["-C", wt, "worktree", "remove", "--force", tmp], { allowFail: true }));
    }
  }

  for (const lf of cfg.lockfiles || []) {
    if (!changed.includes(lf.path)) continue;
    const r = shell(lf.regenerate, wt, path.join(logDir, `lockfile-${path.basename(lf.path)}.log`), timeout);
    const same = run("git", ["-C", wt, "diff", "--quiet", "--", lf.path], { allowFail: true }).code === 0;
    run("git", ["-C", wt, "checkout", "--", lf.path], { allowFail: true });
    record(`lockfile:${lf.path}`, r.code === 0 && same, same ? "regenerated lockfile matches" : "regenerated lockfile differs from the committed one", r);
  }

  const mig = cfg.migrations;
  if (mig && changed.some((f) => matchAny(mig.pathGlobs, f))) {
    for (const step of ["setup", "up", "down", "upAgain"]) {
      const command = step === "upAgain" ? mig.up : mig[step];
      if (!command || (step === "upAgain" && !mig.down)) continue;
      const r = shell(command, wt, path.join(logDir, `migration-${step}.log`), timeout);
      record(`migration:${step}`, r.code === 0, `exit ${r.code}`, r);
      if (r.code !== 0) break;
    }
  }

  run("git", ["-C", wt, "checkout", "--", "."], { allowFail: true });
  return { pass: checks.every((c) => c.pass), headSha: sha, changedFiles: changed, checks };
};

ops["ci-status"] = (cfg, req) => {
  const pr = req.pr;
  const started = Date.now();
  const deadline = started + (req.waitMinutes ?? cfg.ciWaitMinutes) * 60 * 1000;
  for (;;) {
    const view = ghJson(cfg, ["pr", "view", String(pr), "-R", cfg.repo, "--json", "headRefOid"]);
    if (req.expectedSha && view.headRefOid !== req.expectedSha) {
      return { status: "head-changed", headSha: view.headRefOid };
    }
    const r = gh(cfg, ["pr", "checks", String(pr), "-R", cfg.repo, "--required", "--json", "name,state,bucket,link"], { allowFail: true });
    let checks = null;
    try {
      checks = JSON.parse(r.stdout);
    } catch {
      checks = null;
    }
    if (!checks || !checks.length) {
      // GitHub may not have registered checks yet right after a push, so allow 3 minutes.
      if (Date.now() - started > 3 * 60 * 1000) {
        return { status: cfg.requireCi ? "no-checks" : "pass", checks: [] };
      }
    } else {
      const pending = checks.filter((c) => c.bucket === "pending");
      const failing = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
      if (!pending.length) {
        if (!failing.length) return { status: "pass", checks: checks.map((c) => c.name) };
        const logPath = path.join(paths.runDir(cfg, req.number), `ci-${Date.now()}.log`);
        const parts = [];
        for (const c of failing) {
          const m = (c.link || "").match(/actions\/runs\/(\d+)/);
          parts.push(`===== ${c.name} (${c.link}) =====`);
          if (m) parts.push(gh(cfg, ["run", "view", m[1], "-R", cfg.repo, "--log-failed"], { allowFail: true }).stdout.slice(-200000));
        }
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, parts.join("\n"));
        return { status: "fail", failing: failing.map((c) => c.name), logPath };
      }
    }
    if (Date.now() > deadline) return { status: "pending" };
    spawnSync("sleep", ["30"]);
  }
};

// Stages after review, where an issue only waits to merge.
const READY_STAGES = new Set(["sync", "checks", "accept", "security", "merge"]);

// The open issue, other than #n, that should merge before PR `pr`: one past
// review whose PR is older. Without this, a slow issue's long verify keeps
// losing the merge to quick issues in the other slots. An issue whose lease
// expired (a crashed sweep) doesn't hold the line.
function olderReadyIssue(cfg, n, pr) {
  const working = ghJson(cfg, ["issue", "list", "-R", cfg.repo, "--state", "open", "--label", LABELS.working.name, "--limit", "100", "--json", "number,labels"]) || [];
  const leaseMs = cfg.leaseHours * 3600 * 1000;
  let best = null;
  for (const issue of working) {
    if (issue.number === n || issue.labels.some((l) => isStopLabel(l.name))) continue;
    const { state } = readState(cfg, issue.number);
    if (!state || !state.pr || state.pr >= pr || !READY_STAGES.has(state.stage)) continue;
    if (state.lease?.at && Date.now() - Date.parse(state.lease.at) >= leaseMs) continue;
    if (!best || state.pr < best.pr) best = { number: issue.number, pr: state.pr };
  }
  return best;
}

ops.merge = (cfg, req) => {
  const n = req.number;
  const pr = req.state.pr;
  const view = ghJson(cfg, ["pr", "view", String(pr), "-R", cfg.repo, "--json", "headRefOid,state,mergeable,mergeStateStatus,isDraft"]);
  if (view.state === "MERGED") {
    // Someone merged it by hand first. Finish the bookkeeping a merge does.
    finishMerged(cfg, n, pr, req.state);
    return { merged: true, byHand: true };
  }
  if (view.state !== "OPEN") return { merged: false, reason: `PR is ${view.state}` };
  if (view.headRefOid !== req.expectedSha) return { merged: false, reason: "head-changed", headSha: view.headRefOid };
  if (view.mergeable === "CONFLICTING") return { merged: false, reason: "conflict" };
  if (view.mergeStateStatus === "BEHIND") return { merged: false, reason: "behind" };
  // Without branch protection GitHub merges a stale branch without complaint, so
  // check here that the verified commit already contains the current base.
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  if (run("git", ["-C", wt, "merge-base", "--is-ancestor", `origin/${cfg.baseBranch}`, req.expectedSha], { allowFail: true }).code !== 0) {
    return { merged: false, reason: "behind" };
  }
  if (req.mergeOrder) {
    const ahead = olderReadyIssue(cfg, n, pr);
    if (ahead) return { merged: false, reason: "queued", waitingFor: ahead.number, waitingForPr: ahead.pr };
  }
  // The account that opened the PR can't approve it, so there is no review step; the
  // signed comment below records the verdict instead.
  // GitHub won't merge a draft. open-pr marks it ready, but make sure.
  if (view.isDraft) gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo], { allowFail: true });
  const args = ["pr", "merge", String(pr), "-R", cfg.repo, "--squash", "--match-head-commit", req.expectedSha];
  if (cfg.mergeAdmin) args.push("--admin");
  const r = gh(cfg, args, { allowFail: true });
  if (r.code !== 0) {
    const why = tail(r.stderr || r.stdout, 5);
    // Another PR merged first. The next sweep rebases and re-verifies, as for "behind".
    if (/base branch was modified|not up to date with the base|head branch is not up to date/i.test(why)) return { merged: false, reason: "behind" };
    const hint = /approving review|review is required|reviews? required|approv/i.test(why)
      ? " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config."
      : "";
    return { merged: false, reason: `merge refused: ${why}${hint}` };
  }
  comment(cfg, pr, { role: "merger" }, `Merged ${req.expectedSha.slice(0, 12)}: every blocking review finding is resolved and every check passed on this commit.\n\n${req.summary || ""}`);
  finishMerged(cfg, n, pr, req.state);
  return { merged: true };
};

// After a PR merges, by the pipeline or by hand: delete the branch, mark the
// issue done, label both, and remove the worktree (which runs teardown).
function finishMerged(cfg, n, pr, state) {
  gh(cfg, ["api", "-X", "DELETE", `repos/${cfg.repo}/git/refs/heads/${paths.branch(n)}`, "--silent"], { allowFail: true });
  writeState(cfg, n, { ...state, stage: "done", lease: null });
  for (const target of [n, pr]) {
    setLabels(cfg, target, [LABELS.merged.name], [LABELS.working.name]);
    clearStopLabels(cfg, target);
  }
  closeClaims(cfg, n, `PR #${pr} merged.`);
  // GitHub closes an issue from "Closes #N" only when the PR merges into the
  // default branch. A base like integration leaves it open, so close it here.
  const issueState = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}`, "--jq", "{state}"], { allowFail: true });
  if (issueState?.state === "open") {
    gh(cfg, ["issue", "close", String(n), "-R", cfg.repo, "--reason", "completed", "--comment", `PR #${pr} merged into ${cfg.baseBranch}.`], { allowFail: true });
  }
  try {
    const w = pushWiki(cfg, n);
    if (w?.pushed) comment(cfg, n, { role: "merger" }, `Pushed this issue's wiki changes as wiki commit ${w.sha.slice(0, 12)} (history: https://github.com/${cfg.repo}/wiki/_history).`);
  } catch (e) {
    comment(cfg, n, { role: "merger" }, `The wiki changes from this issue were not pushed: ${e.message}`);
    return; // keep the worktree, and its wiki commits, for a person to push
  }
  removeWorktree(cfg, n);
}

ops["close-parent"] = (cfg, req) => {
  const n = req.number;
  const subs = ghJson(cfg, ["api", `repos/${cfg.repo}/issues/${n}/sub_issues?per_page=100`]) || [];
  if (!subs.length) return { closed: false, reason: "no sub-issues found" };
  if (subs.some((s) => s.state !== "closed")) return { closed: false, open: subs.filter((s) => s.state !== "closed").map((s) => s.number) };
  comment(cfg, n, { role: "coordinator" }, `All sub-issues are closed (${subs.map((s) => `#${s.number}`).join(", ")}). Closing.`);
  gh(cfg, ["issue", "close", String(n), "-R", cfg.repo]);
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.split.name]);
  return { closed: true };
};

// Only posts the queued comments (main does that before any op).
ops.post = () => ({});

// The sweep ends with the issue unfinished. Its lane keeps the lease and its claim,
// and its next sweep continues the issue. If the lane never comes back, the lease
// and claim expire after leaseHours and another lane may take the issue.
ops.release = (cfg, req) => {
  const lease = req.state.lease ? { ...req.state.lease, at: new Date().toISOString() } : null;
  writeState(cfg, req.number, { ...req.state, lease });
  touchClaim(cfg, req.number, req);
  return {};
};

// ---------- entry point ----------

function main() {
  const raw = fs.readFileSync(0, "utf8");
  const m = raw.match(/BEGIN_OPS_REQUEST\s*([\s\S]*?)\s*END_OPS_REQUEST/);
  let reply;
  try {
    if (!m) throw new OpsError("no BEGIN_OPS_REQUEST ... END_OPS_REQUEST block on stdin");
    const req = JSON.parse(m[1]);
    const handler = ops[req.op];
    if (!handler) throw new OpsError(`unknown op "${req.op}"`);
    const cfg = loadConfig(req.config);
    fs.mkdirSync(ROOT, { recursive: true });
    // Post the signed comments the workflow queued for this issue before running the op,
    // so they land in order and aren't lost if the op fails.
    let posted = 0;
    for (const c of req.comments || []) {
      comment(cfg, c.number, c.by, c.body);
      posted++;
    }
    reply = { ok: true, op: req.op, posted, ...handler(cfg, req) };
  } catch (err) {
    if (!(err instanceof OpsError) && !(err instanceof SyntaxError)) {
      process.stderr.write(String(err?.stack || err));
    }
    reply = { ok: false, error: String(err?.message || err).slice(0, 4000) };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

main();
