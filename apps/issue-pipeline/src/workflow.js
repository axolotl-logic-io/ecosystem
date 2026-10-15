// Issue pipeline sweep. One run claims one issue and moves it as far as it can:
// triage -> draft PR -> spec -> implement -> PR ready -> review -> fix rounds ->
// sync with base -> checks (local verify + CI) -> acceptance -> security review
// -> merge. To work on more issues at once, run more lanes (one schedule per pi
// session, see the README); the number of lanes is not a setting.
//
// The script holds no tokens' worth of context: every model session is a fresh
// child with one narrow job, and every git/GitHub action goes through the
// deterministic ops tool (ops.mjs) via the `issue-pipeline-ops` agent.
// GitHub is the source of truth: labels plus a hidden state comment per issue.
//
// args: { config: "/abs/path/to/repos/<owner>__<repo>.json", lane: "<lane id>" }
//   lane names the worker. A lane keeps its issue across its sweeps, and lanes
//   race for new issues with claim comments (see raceForClaim in ops.mjs).
//   Without it, the run is its own lane.
//   Optional, for a run a human launches for one issue:
//   issue: N               work only on #N, even with an agent:stopped-* label on it
// Design and decisions: the "Issue pipeline" page of the project-buddy wiki.
//
// The helpers that need no sweep state are strict TypeScript in src/workflow/.
// The build bundles them ahead of this body as `workflowModules`, and
// src/workflow/index.ts lists every name this destructure may read.
// The stages are moving onto a step machine: a ported stage is a sync `next`
// in src/workflow/stages/, run by a loop that does all its awaiting. The loop
// runs twice: after the claim for triage (#178), and after open-pr for review
// and the fix rounds (#179). The other stages are still labelled blocks until
// their ports fill in the stage dispatch.

const {
  acceptanceSummary,
  addFinding,
  by,
  byStep,
  chargeSession,
  clip,
  findingLines,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  noteEvent,
  openFindings,
  practicesNote,
  preamble,
  lenses: LENSES,
  securityRules: SECURITY_RULES,
  acceptSchema: ACCEPT_SCHEMA,
  cifixSchema: CIFIX_SCHEMA,
  implSchema: IMPL_SCHEMA,
  reviewSchema: REVIEW_SCHEMA,
  securitySchema: SECURITY_SCHEMA,
  specSchema: SPEC_SCHEMA,
  stages: STAGES,
} = workflowModules.helpers;

const CONFIG = args.config;
if (!CONFIG) throw new Error("args.config must be the absolute path of a repo config file");
const SWEEP = "s" + Date.now().toString(36);
const ONLY = args.issue ? Number(args.issue) : null;
const LANE = args.lane ? String(args.lane) : SWEEP;
const OPS_AGENT = "issue-pipeline-ops";
let seq = 0;
let spawned = 0;

// Every child, ops steps included, counts against pi-subagents' per-run spawn
// cap (maxSubagentSpawnsPerRun, default 64). spawnAll counts launches, and
// fits() holds the issue at a stage boundary when the rest of the run might
// not fit. A held issue keeps its stage and continues next sweep.
function spawnAll(specs) {
  spawned += specs.length;
  return runs.all(specs);
}

// ---------- ops plumbing ----------

function parseOps(result) {
  if (!result.ok) return { ok: false, error: "ops child failed: " + (result.error || "no detail") };
  const lines = String(result.output || "").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.charAt(0) === "{") {
      try {
        return JSON.parse(line);
      } catch (e) {
        break;
      }
    }
  }
  return { ok: false, error: "ops reply was not JSON: " + String(result.output || "").slice(-500) };
}

function opsSpec(name, op, payload, minutes) {
  seq++;
  const req = Object.assign({ op: op, config: CONFIG, sweepId: SWEEP, lane: LANE }, payload || {});
  // Signed comments queued for this issue ride along on its next ops call (see say()).
  const owner = item && payload && payload.number === item.n ? item : null;
  if (owner && owner.outbox && owner.outbox.length) req.comments = owner.outbox.splice(0, owner.outbox.length);
  return {
    key: name + "-" + seq,
    label: "Run " + op + " operation",
    agent: OPS_AGENT,
    task: "BEGIN_OPS_REQUEST\n" + JSON.stringify(req) + "\nEND_OPS_REQUEST",
    timeoutMs: (minutes || 10) * 60000,
    // ops.mjs prints nothing until it finishes, so the default 60 s silence alert
    // fires on every verify and CI wait. The timeout already bounds the step.
    control: { needsAttentionAfterMs: (minutes || 10) * 60000 },
  };
}

function opsAll(specs) {
  if (!specs.length) return Promise.resolve([]);
  return spawnAll(specs).then((results) => results.map(parseOps));
}

// ---------- sweep ----------

// The one issue this sweep works on, set at claim.
let item = null;
const sweep = (await opsAll([opsSpec("sweep", "sweep", ONLY ? { only: ONLY } : {}, 20)]))[0];
if (!sweep.ok) throw new Error("sweep failed: " + sweep.error);
const cfg = sweep.config;

const CAP = cfg.sessionTokenCap;
const BUDGET = cfg.issueTokenBudget;
const ROLE = Object.assign(
  { triage: 50000, spec: 80000, implementer: 150000, reviewer: 60000, aggregator: 20000, fixer: 100000, rereviewer: 40000, ciFixer: 100000, verifier: 60000 },
  cfg.roleBudgets || {},
);
const BUDGETS = { roles: ROLE, sessionCap: CAP, issueBudget: BUDGET };
const MODEL = Object.assign(
  {
    triage: "anthropic/claude-opus-5-5",
    spec: "anthropic/claude-opus-5-5",
    implementer: "anthropic/claude-opus-5-5",
    correctness: "anthropic/claude-opus-5-5",
    tests: "anthropic/claude-opus-5-5",
    scope: "anthropic/claude-sonnet-5-5",
    aggregator: "anthropic/claude-sonnet-5-5",
    fixer: "anthropic/claude-opus-5-5",
    verifier: "anthropic/claude-sonnet-5-5",
    security: "anthropic/claude-opus-5-5",
  },
  cfg.models || {},
);
const WRITER_ACCEPTANCE = { level: "none", reason: "The pipeline verifies changes with its own commands and reviewers." };
const SPAWN_LIMIT = cfg.maxSpawnsPerRun || 64;
const STAGE_SPAWNS = { triage: 4, spec: 3, implement: 1, "open-pr": 2, review: 7, fix: 8, sync: 3, checks: 11, accept: 2, security: 3, merge: 2 };

// ---------- item helpers ----------

const stopQueue = [];
const SPEC_META = {};

function logEvent(item, text) {
  noteEvent(item.st, text, new Date());
}

function stopIssue(item, reason, detail, nextStep, code) {
  if (item.closed) return;
  item.closed = true;
  item.outcome = "stopped";
  item.reason = reason;
  logEvent(item, "stopped: " + reason);
  stopQueue.push(opsSpec("i" + item.n + "-stop", "stop", { number: item.n, state: item.st, reason: reason, detail: clip(detail || "", 3000), nextStep: nextStep || null, code: code || null }));
}

function flushStops() {
  const specs = stopQueue.splice(0, stopQueue.length);
  return opsAll(specs);
}

function charge(item, role, count) {
  const result = chargeSession(BUDGETS, item.st, role, count);
  if (!result.charged) stopIssue(item, "issue token budget exhausted", result.detail);
  return result.charged;
}

function noteUsage(item, result) {
  const u = result && result.results && result.results[0] && result.results[0].usage;
  if (u) item.st.reportedTokens = (item.st.reportedTokens || 0) + (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
}

// The issue, if it is open and at this stage.
function at(stage) {
  return item && !item.closed && item.st.stage === stage ? item : null;
}

// Whether the issue's next stage fits under the spawn cap. If not, it is held.
function fits(stage) {
  // Keep room for a release or stop op and a final comment post, plus parent closing.
  const reserve = 3 * (item ? 1 : 0) + sweep.parents.length + 1;
  if (spawned + STAGE_SPAWNS[stage] + reserve <= SPAWN_LIMIT) return true;
  if (!item.held) {
    item.held = true;
    logEvent(item, "held at " + stage + " by the per-run spawn cap; continues next sweep");
  }
  return false;
}

// The issue, if it is at this stage and the stage fits.
function take(stage) {
  return at(stage) && fits(stage) ? item : null;
}

function saveOf(it) {
  return it && !it.closed ? [opsSpec("i" + it.n + "-save", "save-state", { number: it.n, state: it.st })] : [];
}

function saveAt(stage) {
  return saveOf(at(stage));
}

// ---------- signed comments ----------
// Each comment is signed by its writer: by() for a child, byStep() for a
// deterministic step (src/workflow/signing.ts).

function say(item, who, body, where) {
  const number = where === "issue" || !item.st.pr ? item.n : item.st.pr;
  item.outbox.push({ number: number, by: who, body: clip(body, 60000) });
}

function child(item, name, opts) {
  seq++;
  const spec = {
    key: "i" + item.n + "-" + name + "-" + seq,
    label: opts.label,
    agent: opts.agent,
    model: opts.model,
    cwd: item.paths.worktree,
    task: opts.task,
    outputSchema: opts.schema,
    timeoutMs: (opts.minutes || 30) * 60000,
    // pi-subagents adds contact_supervisor to every child unless the bridge is off.
    // No one answers an unattended sweep, so a question would hang until the timeout.
    intercomBridge: { mode: "off" },
  };
  if (opts.writer) spec.acceptance = WRITER_ACCEPTANCE;
  SPEC_META[spec.key] = { agent: opts.agent, model: opts.model };
  return spec;
}

function out(result) {
  return result && result.ok && result.structuredOutput ? result.structuredOutput : null;
}

// ---------- claim ----------

// Claim the candidates in order until one claim wins. A lost claim was taken by
// another lane first; ops.mjs has already noted on the issue that this lane abandoned it.
const abandoned = [];
for (const c of sweep.items) {
  const n = c.number;
  const r = (await opsAll([opsSpec("i" + n + "-claim", "claim", { number: n }, 15)]))[0];
  if (r.ok && r.lost) {
    abandoned.push({ issue: n, holder: r.holder || null, commented: !!r.posted });
    continue;
  }
  if (!r.ok) {
    item = { n: n, st: null, closed: true, outcome: "claim-failed", reason: r.error, outbox: [] };
  } else {
    item = { n: n, st: r.state, paths: r.paths, closed: false, outcome: null, outbox: [] };
    if (item.st.headSha && r.remoteHead && r.remoteHead !== item.st.headSha) {
      stopIssue(item, "the PR branch changed outside the pipeline", "Expected " + item.st.headSha + ", found " + r.remoteHead + ".");
    }
  }
  break;
}
await flushStops();

// ---------- stages on the step machine ----------
// A ported stage is a sync step machine (src/workflow/stages/): its `next`
// takes the issue's state and the results of its last launches, and returns
// the next step. This loop does all their launching and awaiting.

const STAGE_CONTEXT = {
  cfg,
  budgets: BUDGETS,
  models: MODEL,
  now: () => new Date(),
};
const stagesRun = {};

// The issue as its stage sees it, read fresh from `item`, with what the stage
// carries to its next step.
function stageState(phase, carry) {
  return {
    n: item.n,
    paths: item.paths,
    st: item.st,
    closed: item.closed,
    outcome: item.outcome,
    phase,
    carry,
  };
}

function launchSpec(launch) {
  if (launch.kind === "op") {
    const name = `i${item.n}-${launch.name}`;
    return opsSpec(name, launch.op, launch.payload, launch.minutes);
  }
  return child(item, launch.name, launch);
}

// Applies a step to the issue: its state, then its comments, then its stop,
// so a comment rides on the next ops request. A done step with `again` lets
// its stage begin again. Returns its launches' specs.
function applyStep(step) {
  item.st = step.state.st;
  item.closed = step.state.closed;
  item.outcome = step.state.outcome;
  for (const comment of step.comments) {
    say(item, comment.by, comment.body, comment.where);
  }
  if (step.stop) {
    stopIssue(item, step.stop.reason, step.stop.detail, null, step.stop.code);
  }
  if (step.done) {
    if (step.again) {
      delete stagesRun[item.st.stage];
    }
    return [];
  }
  return step.launches.map(launchSpec);
}

// The launches' results as a stage reads them, each session's tokens counted.
function launchResults(launches, raw) {
  return launches.map((launch, index) => {
    const result = raw[index];
    if (launch.kind === "op") {
      return { kind: "op", reply: parseOps(result) };
    }
    noteUsage(item, result);
    return {
      kind: "child",
      ok: result.ok === true,
      structuredOutput: result.structuredOutput ?? null,
      error: result.error || null,
      by: by(SPEC_META, result, launch.name),
    };
  });
}

// The issue's stage machine and its first step, if the stage is one of
// `stages`, is on the step machine, hasn't run this sweep (or asked to go
// again) and fits under the spawn cap.
function beginStage(stages) {
  if (!item || item.closed) {
    return null;
  }
  const { stage } = item.st;
  if (!stages.includes(stage) || !Object.hasOwn(STAGES, stage) || Object.hasOwn(stagesRun, stage)) {
    return null;
  }
  const { [stage]: machine } = STAGES;
  if (!(machine && take(stage))) {
    return null;
  }
  stagesRun[stage] = true;
  const step = machine.next(stageState("begin", null), STAGE_CONTEXT, []);
  return { machine, step };
}

let stageRun = beginStage(["triage"]);
while (stageRun) {
  const specs = applyStep(stageRun.step);
  if (stageRun.step.done) {
    stageRun = beginStage(["triage"]);
  } else {
    const { machine, step } = stageRun;
    const results = launchResults(step.launches, await spawnAll(specs));
    const state = stageState(step.state.phase, step.state.carry);
    stageRun.step = machine.next(state, STAGE_CONTEXT, results);
  }
}
await flushStops();
await opsAll(saveAt("spec"));

// ---------- spec: what exactly to build, from the issue, wiki, code and web ----------
// Autumn (2026-10-13): every issue gets a spec before implementation. It is posted
// on the issue, and the implementer and the acceptance check work from it.

spec: {
  const it = take("spec");
  if (!it || !charge(it, "spec")) break spec;
  const r = (
    await spawnAll([
      child(it, "spec", {
        label: "Write the spec for issue " + it.n,
        agent: "issue-pipeline-specifier",
        model: MODEL.spec,
        schema: SPEC_SCHEMA,
        minutes: 30,
        task: preamble(cfg, it, "spec writer", ROLE.spec)
          .concat([
            "Triage found this issue ready. Its notes:\n" + (it.st.plan || "(none)"),
            "",
            "Write the spec the implementer will build to and the acceptance check will judge against. Read, in this order: the issue; the project's coding practices (below); the wiki pages that bear on it" + (it.paths.wiki ? " (start from " + it.paths.wiki + "/Home.md)" : "") + "; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.",
            practicesNote(cfg, it, "spec"),
            "`spec` is GitHub markdown with these sections:",
            "- **Behaviour**: what is true when the issue is done, as checkable statements.",
            "- **Out of scope**: what this issue does not change.",
            "- **Design**: the approach, the files to change with `file:line` anchors, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and say the implementer must update that wiki page.",
            "- **Tests**: the tests to add or change, each naming the behaviour it pins down and why it fails today.",
            "- **Wiki updates**: wiki pages to add or change, or \"None\".",
            "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
            "Keep it under about 150 lines. Set `decision` to ready, with `questions` empty.",
            "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, and put what you found so far in `spec`.",
          ])
          .join("\n"),
      }),
    ])
  )[0];
  noteUsage(it, r);
  const o = out(r);
  if (!o) {
    stopIssue(it, "the spec writer failed", r.error);
    break spec;
  }
  const who = by(SPEC_META, r, "spec writer");
  logEvent(it, "spec: " + o.decision);
  if (o.decision === "needs-info" && o.questions.length) {
    it.closed = true;
    it.outcome = "needs-info";
    say(it, who, "## Spec so far\n\n" + o.spec, "issue");
    const ar = (await opsAll([opsSpec("i" + it.n + "-ask", "ask", { number: it.n, state: Object.assign({}, it.st, { stage: "triage" }), questions: o.questions, by: who })]))[0];
    if (!ar.ok) throw new Error("spec follow-up failed: " + ar.error);
    break spec;
  }
  it.st.spec = clip(o.spec, 12000);
  it.st.stage = "implement";
  say(it, who, "## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n" + o.spec, "issue");
}
await flushStops();
await opsAll(saveAt("implement"));

// ---------- implement (one continuation allowed) ----------

for (let pass = 0; pass < 2; pass++) {
  const it = take("implement");
  if (!it || !charge(it, "implementer")) break;
  const r = (
    await spawnAll([
      child(it, "implement", {
        label: "Implement issue " + it.n,
        agent: "issue-pipeline-writer",
        model: MODEL.implementer,
        schema: IMPL_SCHEMA,
        writer: true,
        minutes: 90,
        task: preamble(cfg, it, "implementer", CAP)
          .concat([
            practicesNote(cfg, it, "writer"),
            it.st.continuations > 0
              ? "A previous session ran out of room. Read its handoff first: " + it.paths.handoffFile + ". Continue from the current branch state."
              : it.st.spec
                ? "Spec (also posted on the issue):\n" + it.st.spec
                : "Triage plan:\n" + it.st.plan,
            "",
            "Do this:",
            "1. Write or update tests that specify the fix. They must fail without your change.",
            "2. Implement the smallest change that resolves the issue. Do not refactor unrelated code.",
            "3. Run the tests" + (cfg.commands.test ? " (`" + cfg.commands.test + "`)" : "") + (cfg.commands.lint ? ", lint (`" + cfg.commands.lint + "`)" : "") + (cfg.commands.typecheck ? ", and typecheck (`" + cfg.commands.typecheck + "`)" : "") + " and fix failures.",
            "4. Commit everything with clear messages (`git add -A && git commit`), ending each message with the trailer line `Pipeline-Agent: implementer`. Leave the worktree clean.",
            it.paths.wiki
              ? "5. Make the wiki updates the spec lists, and record any new design decision, in the wiki checkout: edit its pages, then commit there (`git -C " + it.paths.wiki + " add -A && git -C " + it.paths.wiki + " commit`, same trailer). Leave it clean too. Reviewers see those commits, and they reach the wiki when the PR merges."
              : "",
            "Change lockfiles only through the package manager, never by hand.",
            "",
            "If the work is bigger than this session can finish within budget (for example, you have read more than about 15 files or made more than about 30 substantial tool calls and are not close), stop: commit what builds, write " +
              it.paths.handoffFile +
              " (what is done, what is left, current branch state), and return status `handoff`.",
            "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
            "`prTitle` and `prBody` describe the change for reviewers (body: what changed and why, and how it is tested).",
          ])
          .join("\n"),
      }),
    ])
  )[0];
  noteUsage(it, r);
  const o = out(r);
  if (!o) {
    stopIssue(it, "the implementer session failed", r.error);
  } else {
    logEvent(it, "implement: " + o.status + " - " + o.summary);
    const who = by(SPEC_META, r, "implementer");
    if (o.status === "done") {
      it.st.prTitle = clip(o.prTitle, 200);
      it.st.prBody = clip(o.prBody, 6000);
      it.st.prBy = who;
      it.st.stage = "open-pr";
    } else if (o.status === "handoff" && it.st.continuations < 1) {
      it.st.continuations += 1;
      say(it, who, "This session ran out of room before finishing. A second implementer session continues from its handoff.\n\n" + o.summary, "issue");
    } else if (o.status === "handoff") {
      say(it, who, o.summary, "issue");
      stopIssue(it, "the implementer ran out of room twice; the issue needs splitting", "Latest handoff: " + it.paths.handoffFile + "\n\n" + o.summary);
    } else {
      say(it, who, o.summary, "issue");
      stopIssue(it, "the implementer could not do the issue as written", o.summary);
    }
  }
  await flushStops();
}
// Still in implement after both passes, and not held: it has used its continuation.
if (at("implement") && !item.held) stopIssue(item, "implementation did not finish within its sessions");
await flushStops();

// ---------- open PR ----------

{
  const it = take("open-pr");
  if (it) {
    const r = (await opsAll([opsSpec("i" + it.n + "-openpr", "open-pr", { number: it.n, title: it.st.prTitle, body: it.st.prBody, by: it.st.prBy })]))[0];
    if (!r.ok) {
      stopIssue(it, "could not open the PR", r.error);
    } else {
      it.st.pr = r.pr;
      it.st.headSha = r.headSha;
      it.st.implemented = true;
      it.st.stage = "review";
      logEvent(it, "PR #" + r.pr + " is ready for review");
    }
  }
}
await flushStops();
await opsAll(saveAt("review"));

// ---------- review and fix rounds, on the step machine ----------
// The same loop as after the claim, for the review and fix stages, so an issue
// open-pr moved to review is reviewed in this sweep. A fix round that leaves
// findings open ends with an again step, and fix begins again only if it
// still fits under the spawn cap.

stageRun = beginStage(["review", "fix"]);
while (stageRun) {
  const specs = applyStep(stageRun.step);
  if (stageRun.step.done) {
    stageRun = beginStage(["review", "fix"]);
  } else {
    const { machine, step } = stageRun;
    const results = launchResults(step.launches, await spawnAll(specs));
    const state = stageState(step.state.phase, step.state.carry);
    stageRun.step = machine.next(state, STAGE_CONTEXT, results);
  }
}
await flushStops();

// ---------- sync with base ----------

sync: {
  const it = take("sync");
  if (!it) break sync;
  // A conflicting rebase is left stopped for a writer to resolve, while the
  // issue has conflict attempts and budget left. The resolution then goes
  // through every check again, like any rebase.
  const maxConflictFixes = cfg.maxConflictFixes == null ? 2 : cfg.maxConflictFixes;
  const canResolve = (it.st.conflictFixes || 0) < maxConflictFixes && it.st.allocated + Math.min(ROLE.fixer, CAP) <= BUDGET;
  const r = (await opsAll([opsSpec("i" + it.n + "-sync", "sync-base", { number: it.n, keepConflict: canResolve })]))[0];
  if (!r.ok) {
    stopIssue(it, "could not sync with " + cfg.baseBranch, r.error);
    break sync;
  }
  if (r.conflict && !r.inRebase) {
    const why = (it.st.conflictFixes || 0) >= maxConflictFixes ? " again after " + maxConflictFixes + " resolutions" : "";
    stopIssue(it, "rebasing onto " + cfg.baseBranch + " conflicts" + why, "Conflicting files:\n" + (r.conflicts || []).join("\n"));
    break sync;
  }
  if (!r.conflict) {
    if (r.changed) {
      it.st.syncs = (it.st.syncs || 0) + 1;
      if (it.st.syncs > cfg.maxSyncs) {
        stopIssue(it, cfg.baseBranch + " kept moving; rebased " + cfg.maxSyncs + " times without merging");
        break sync;
      }
    }
    // A clean rebase of a head that passed every check, acceptance and the security
    // review only re-runs the tests (Autumn, 2026-10-14): the change itself is the same.
    it.st.testsOnly = !!it.st.passedSha && it.st.passedSha === it.st.headSha;
    it.st.passedSha = null;
    if (r.changed) {
      logEvent(it, "rebased onto " + cfg.baseBranch + (it.st.testsOnly ? "; re-running only the tests" : ""));
      say(it, byStep("sync"), "Rebased onto " + cfg.baseBranch + " without conflicts; the head is now " + r.headSha.slice(0, 12) + ". " + (it.st.testsOnly ? "This head already passed every check before the rebase, so only the tests run again before merge." : "Rebases aren't re-reviewed; the checks run again."));
    }
    it.st.headSha = r.headSha;
    it.st.stage = "checks";
    break sync;
  }

  // The rebase stopped on conflicts; a writer finishes it. Its resolution changes
  // the code, so every check runs again.
  it.st.testsOnly = false;
  it.st.passedSha = null;
  const files = r.conflicts || [];
  it.st.conflictFixes = (it.st.conflictFixes || 0) + 1;
  charge(it, "fixer");
  const res = (
    await spawnAll([
      child(it, "conflicts-" + it.st.conflictFixes, {
        label: "Resolve rebase conflicts for issue " + it.n,
        agent: "issue-pipeline-writer",
        model: MODEL.fixer,
        schema: CIFIX_SCHEMA,
        writer: true,
        minutes: 45,
        task: preamble(cfg, it, "conflict resolver, attempt " + it.st.conflictFixes + " of " + maxConflictFixes, ROLE.fixer)
          .concat([
            "The pipeline is rebasing this branch onto origin/" + cfg.baseBranch + " (" + String(r.baseSha).slice(0, 12) + "), and the rebase stopped on conflicts in:",
            files.map((f) => "- " + f).join("\n"),
            "",
            "Finish the rebase. For each stopped commit, read what " + cfg.baseBranch + " changed in the conflicting files (`git log -p ORIG_HEAD..origin/" + cfg.baseBranch + " -- <file>` or `git diff <merge-base> origin/" + cfg.baseBranch + " -- <file>`) and what this branch changed, and write a resolution that keeps the intent of both. Then `git add` the files and run `GIT_EDITOR=true git rebase --continue`; repeat if a later commit stops too.",
            "Code that merged without a textual conflict can still break: " + cfg.baseBranch + " may use a name or field this branch renamed or removed. After the rebase finishes, run the repo's type check and the unit tests for the touched areas, and fix what broke in a new commit ending with the trailer line `Pipeline-Agent: conflict resolver`. The pipeline runs the full checks afterwards.",
            "Never run `git rebase --abort`, `git reset` to another commit, or `git push`. Leave the rebase finished and the worktree clean. No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what " + cfg.baseBranch + " now does and re-apply this branch's change on top of it as far as it still makes sense, and say in your summary what you chose. Return `cannot-fix` only if you could not finish the rebase at all; a fresh resolver then tries again next sweep.",
          ])
          .join("\n"),
      }),
    ])
  )[0];
  noteUsage(it, res);
  const o = out(res);
  const abort = !o || o.status === "cannot-fix";
  const f = (await opsAll([opsSpec("i" + it.n + "-finish-sync", "finish-sync", { number: it.n, abort: abort, reason: o ? o.summary : "the conflict resolver failed" })]))[0];
  const fileList = "Conflicting files:\n" + files.join("\n");
  if (!o) {
    stopIssue(it, "the conflict-resolver session failed", fileList + "\n\n" + String(res.error || ""));
    break sync;
  }
  say(it, by(SPEC_META, res, "conflict resolver (attempt " + it.st.conflictFixes + ")"), (o.status === "cannot-fix" ? "I couldn't resolve the conflicts with " + cfg.baseBranch + ": " : "") + o.summary);
  if (o.status === "cannot-fix") {
    // Conflicts never wait for a human (Autumn, 2026-10-13): a fresh resolver tries again
    // next sweep, against a base that may have moved, until the budget runs out.
    logEvent(it, "conflict resolver found no resolution: " + o.summary + "; will retry next sweep");
    break sync; // stays at sync
  }
  if (!f.ok) {
    stopIssue(it, "could not finish the rebase after resolving conflicts", f.error);
    break sync;
  }
  if (!f.resolved) {
    if (it.st.conflictFixes >= maxConflictFixes) stopIssue(it, "the conflict resolution was rejected", fileList + "\n\n" + f.reason);
    else logEvent(it, "conflict resolution rejected: " + f.reason + "; will retry next sweep"); // stays at sync; the next sweep rebases again
    break sync;
  }
  it.st.syncs = (it.st.syncs || 0) + 1;
  logEvent(it, "resolved conflicts with " + cfg.baseBranch + " and rebased");
  say(it, byStep("sync"), "Rebased onto " + cfg.baseBranch + " after resolving conflicts in " + files.map((x) => "`" + x + "`").join(", ") + "; the head is now " + f.headSha.slice(0, 12) + ". Every check runs again on it.");
  it.st.headSha = f.headSha;
  it.st.stage = "checks";
}
await flushStops();

// ---------- checks: local verification, then CI; CI-fix attempts ----------

for (let iter = 0; iter <= cfg.maxCiFixes; iter++) {
  const waiting = at("checks");
  const it = waiting && !waiting.pendingCi && fits("checks") ? waiting : null;
  if (!it) break;
  let failure = null;
  // A head that already passed local verification (e.g. waiting on CI last sweep) skips straight to CI.
  let toCi = !!(it.st.verifiedSha && it.st.verifiedSha === it.st.headSha);
  if (!toCi) {
    const v = (await opsAll([opsSpec("i" + it.n + "-verify", "verify", { number: it.n, testsOnly: !!it.st.testsOnly }, 120)]))[0];
    if (!v.ok) stopIssue(it, "local verification could not run", v.error);
    else if (v.headSha !== it.st.headSha) stopIssue(it, "the branch changed during verification");
    else {
      const table = v.checks.map((c) => "- " + (c.pass ? "✅" : "❌") + " " + c.id + ": " + c.detail).join("\n");
      say(it, byStep("local checks"), "Ran the repo's commands on " + v.headSha.slice(0, 12) + ".\n\n" + table);
      if (!v.pass) {
        const bad = v.checks.filter((c) => !c.pass);
        failure = bad.map((c) => "- " + c.id + ": " + c.detail + (c.log ? " (log: " + c.log + ")" : "") + (c.tail ? "\n" + c.tail : "")).join("\n");
      } else {
        it.st.verifiedSha = v.headSha;
        it.st.verifySummary = clip(v.checks.map((c) => c.id + ": " + c.detail).join("; "), 1500);
        toCi = true;
      }
    }
  }
  if (toCi) {
    const c = (await opsAll([opsSpec("i" + it.n + "-ci", "ci-status", { number: it.n, pr: it.st.pr, expectedSha: it.st.headSha }, cfg.ciWaitMinutes + 10)]))[0];
    if (!c.ok) stopIssue(it, "could not read CI status", c.error);
    else if (c.status === "pass") {
      it.rebasedOnly = !!it.st.testsOnly;
      it.st.stage = it.st.testsOnly ? "merge" : "accept";
      it.st.testsOnly = false;
      logEvent(it, "checks passed at " + it.st.headSha.slice(0, 8) + (it.rebasedOnly ? "; acceptance and security passed before the rebase" : ""));
    } else if (c.status === "pending") {
      it.pendingCi = true;
      logEvent(it, "CI still running; will check next sweep");
    } else if (c.status === "fail") {
      say(it, byStep("CI"), "Required checks failed on " + it.st.headSha.slice(0, 12) + ": " + c.failing.join(", ") + ".");
      failure = "CI checks failed: " + c.failing.join(", ") + "\nFailed-job logs: " + c.logPath;
    } else if (c.status === "no-checks") {
      stopIssue(it, "the PR has no required CI checks, and this repo's config requires them");
    } else {
      stopIssue(it, "the branch changed outside the pipeline while CI ran", c.headSha);
    }
  }
  await flushStops();
  if (failure && it.st.ciFixes >= cfg.maxCiFixes) {
    stopIssue(it, "checks still fail after " + cfg.maxCiFixes + " CI-fix attempts", failure);
    failure = null;
  }
  const fixable = failure && charge(it, "ciFixer");
  await flushStops();
  // Without a fix to try, the item has passed, is waiting on CI, or has stopped.
  if (!fixable) continue;
  it.st.ciFixes += 1;
  let scoped = null;
  ciFix: {
    const r = (
      await spawnAll([
        child(it, "cifix-" + it.st.ciFixes, {
          label: "Fix failing checks for issue " + it.n,
          agent: "issue-pipeline-writer",
          model: MODEL.fixer,
          schema: CIFIX_SCHEMA,
          writer: true,
          minutes: 60,
          task: preamble(cfg, it, "check fixer, attempt " + it.st.ciFixes + " of " + cfg.maxCiFixes, ROLE.ciFixer)
            .concat([
              practicesNote(cfg, it, "writer"),
              "These checks failed:",
              failure,
              "",
              "Find the cause and fix it with the smallest change. If `fails-before-fix` failed, the tests do not prove the change: strengthen them so they fail without the fix. If a lockfile check failed, regenerate the lockfile with the package manager.",
              "Run the failing check locally, then commit (`git add -A && git commit`, ending each message with the trailer line `Pipeline-Agent: check fixer`) and leave the worktree clean. Return `cannot-fix` if the failure is unrelated to this change (for example, a flaky or broken check on " + cfg.baseBranch + ").",
            ])
            .join("\n"),
        }),
      ])
    )[0];
    noteUsage(it, r);
    const o = out(r);
    if (!o) {
      stopIssue(it, "the check-fixer session failed", r.error);
      break ciFix;
    }
    say(it, by(SPEC_META, r, "check fixer (attempt " + it.st.ciFixes + ")"), (o.status === "cannot-fix" ? "I can't fix this from the branch: " : "") + o.summary);
    if (o.status === "cannot-fix") {
      stopIssue(it, "the failing checks look unrelated to this change", o.summary);
      break ciFix;
    }
    logEvent(it, "check fix " + it.st.ciFixes + ": " + o.summary);
    await flushStops();
    const pushed = (await opsAll([opsSpec("i" + it.n + "-push", "push", { number: it.n })]))[0];
    if (!pushed.ok) {
      stopIssue(it, "could not push the check fix", pushed.error);
      break ciFix;
    }
    it.st.headSha = pushed.headSha;
    // A check fix changes code, so acceptance and the security review run again.
    it.st.testsOnly = false;
    scoped = it;
    // A check fix changes reviewed code, so the correctness and scope lenses look at just that diff.
    const p = (await opsAll([opsSpec("i" + it.n + "-prep", "prepare-review", { number: it.n, sinceSha: it.st.reviewedSha, tag: "cifix" + it.st.ciFixes })]))[0];
    if (!p.ok) {
      stopIssue(it, "could not prepare the check-fix diff", p.error);
      break ciFix;
    }
    if (!charge(it, "rereviewer", 2)) break ciFix;
    const lenses = ["correctness", "scope"];
    const sr = await spawnAll(
      lenses.map((lens) =>
        child(it, "cifix-review-" + lens + "-" + it.st.ciFixes, {
          label: "Review " + lens + " of check fix for issue " + it.n,
          agent: "issue-pipeline-reader",
          model: MODEL[lens],
          schema: REVIEW_SCHEMA,
          minutes: 20,
          task: preamble(cfg, it, "check-fix reviewer (" + lens + ")", ROLE.rereviewer)
            .concat([
              "Concern: " + LENSES[lens],
              "Review only the diff at " + p.diffPath + ", which fixed failing checks after the PR passed review. Report only blocking defects this diff introduced. Do not edit files.",
            ])
            .join("\n"),
        }),
      ),
    );
    // Post every lens's comment before stopping, so none is lost.
    const srStops = [];
    sr.forEach((r, i) => {
      noteUsage(it, r);
      const o = out(r);
      if (!o) return srStops.push(["a check-fix reviewer failed", r.error]);
      const blocking = o.findings.filter((f) => f.severity === "blocking");
      say(
        it,
        by(SPEC_META, r, "check-fix reviewer (" + lenses[i] + ")"),
        "Review of the check fix in " + it.st.headSha.slice(0, 12) + ".\n\n" + (blocking.length ? "**Blocking**\n\n" + findingLines(blocking) : "No blocking findings."),
      );
      if (blocking.length) srStops.push(["the check fix introduced a blocking problem", blocking.map((f) => f.file + ":" + f.line + " " + f.title + " - " + f.evidence).join("\n")]);
    });
    srStops.forEach((s) => stopIssue(it, s[0], s[1]));
    if (!it.closed) it.st.reviewedSha = it.st.headSha;
  }
  await flushStops();
  await opsAll(saveOf(scoped));
}
if (at("checks") && !item.pendingCi && !item.held) stopIssue(item, "checks did not pass within the CI-fix limit");
await flushStops();

// ---------- acceptance: does the result do what the issue asked? ----------

accept: {
  const it = take("accept");
  if (!it || !charge(it, "verifier")) break accept;
  const p = (await opsAll([opsSpec("i" + it.n + "-prep", "prepare-review", { number: it.n, tag: "final" })]))[0];
  if (!p.ok) {
    stopIssue(it, "could not prepare the final diff", p.error);
    break accept;
  }
  if (p.headSha !== it.st.verifiedSha) {
    stopIssue(it, "the branch changed after verification");
    break accept;
  }
  const r = (
    await spawnAll([
      child(it, "accept", {
        label: "Check issue " + it.n + " is resolved",
        agent: "issue-pipeline-reader",
        model: MODEL.verifier,
        schema: ACCEPT_SCHEMA,
        minutes: 25,
        task: preamble(cfg, it, "acceptance verifier", ROLE.verifier)
          .concat([
            "Decide whether the change, as a whole, does what the issue asks. Tests, lint, and CI already pass (" + (it.st.verifySummary || "") + "); do not re-run them.",
            it.st.spec ? "The spec it was built to (also on the issue):\n" + it.st.spec + "\n" : "",
            "Full diff against " + cfg.baseBranch + ": " + p.diffPath + ".",
            "Return `pass` only if every requirement in the issue" + (it.st.spec ? " and every Behaviour and Wiki update in the spec" : "") + " is met and nothing in the diff works against the issue. Otherwise `fail` with the unmet requirement. Do not edit files.",
          ])
          .join("\n"),
      }),
    ])
  )[0];
  noteUsage(it, r);
  const o = out(r);
  if (!o) {
    stopIssue(it, "the acceptance verifier failed", r.error);
    break accept;
  }
  logEvent(it, "acceptance: " + o.verdict + " - " + o.reason);
  say(it, by(SPEC_META, r, "acceptance verifier"), (o.verdict === "pass" ? "✅ The change does what the issue asks. " : "❌ The change doesn't fully resolve the issue. ") + o.reason);
  if (o.verdict !== "pass") {
    stopIssue(it, "the acceptance verifier found the issue is not fully resolved", o.reason);
    break accept;
  }
  // Kept in the state: a merge queued behind an older PR runs in a later sweep.
  it.st.acceptReason = o.reason;
  it.st.stage = "security";
}
await flushStops();

// ---------- security review: the last review round before merge ----------

let securityReviewed = null;
security: {
  const it = take("security");
  if (!it || !charge(it, "reviewer")) break security;
  const p = (await opsAll([opsSpec("i" + it.n + "-prep", "prepare-review", { number: it.n, tag: "security-" + ((it.st.securityRounds || 0) + 1) })]))[0];
  if (!p.ok) {
    stopIssue(it, "could not prepare the security review diff", p.error);
    break security;
  }
  if (p.headSha !== it.st.verifiedSha) {
    stopIssue(it, "the branch changed after verification");
    break security;
  }
  securityReviewed = it;
  const r = (
    await spawnAll([
      child(it, "security", {
        label: "Security review of issue " + it.n,
        agent: "issue-pipeline-reader",
        model: MODEL.security,
        schema: SECURITY_SCHEMA,
        minutes: 25,
        task: preamble(cfg, it, "security reviewer", ROLE.reviewer)
          .concat([
            "You are the last review before this PR merges. Review the full diff against " + cfg.baseBranch + " at " + p.diffPath + " (" + p.diffLines + " lines), reading surrounding code where needed, for harm to the app's users and the operator.",
          ])
          .concat(SECURITY_RULES)
          .concat(["Cite file, line and concrete evidence for each finding. Return an empty list if you find nothing. Do not edit files."])
          .join("\n"),
      }),
    ])
  )[0];
  noteUsage(it, r);
  const o = out(r);
  if (!o) {
    stopIssue(it, "the security reviewer failed", r.error);
    break security;
  }
  const who = by(SPEC_META, r, "security reviewer");
  if (!o.findings.length) {
    logEvent(it, "security review: no findings");
    say(it, who, "🛡️ Security review of " + it.st.verifiedSha.slice(0, 12) + ": no harm to users, their rights or money, and no new abuse risk.");
    it.st.stage = "merge";
    break security;
  }
  it.st.securityRounds = (it.st.securityRounds || 0) + 1;
  const added = o.findings.map((f) => addFinding(it, f, ["security"]));
  say(
    it,
    who,
    "🛡️ Security review of " + it.st.verifiedSha.slice(0, 12) + " found " + added.length + " blocking finding(s). Later comments refer to these ids.\n\n" +
      added.map((f) => "- **" + f.id + "** (" + f.category + ") `" + f.file + ":" + f.line + "` " + f.title + "\n  " + f.evidence).join("\n"),
  );
  logEvent(it, "security review " + it.st.securityRounds + ": " + added.length + " finding(s)");
  if (it.st.securityRounds > cfg.maxFixRounds) {
    stopIssue(it, findingsStopReason(cfg, it, "security findings remain"), findingsText(openFindings(it)), null, findingsStopCode(it));
    break security;
  }
  // Fix with fresh fix rounds; the fixed branch then goes back through sync,
  // checks, acceptance and this review.
  it.st.reviewedSha = it.st.verifiedSha;
  it.st.round = 0;
  it.st.stage = "fix";
}
await flushStops();
await opsAll(saveOf(securityReviewed));

// ---------- merge ----------

merge: {
  const it = take("merge");
  if (!it) break merge;
  if (openFindings(it).length) {
    stopIssue(it, findingsStopReason(cfg, it, "open blocking findings remain at merge time"), findingsText(openFindings(it)), null, findingsStopCode(it));
    break merge;
  }
  const r = (
    await opsAll([
      opsSpec("i" + it.n + "-merge", "merge", {
        number: it.n,
        state: it.st,
        expectedSha: it.st.verifiedSha,
        mergeOrder: true,
        summary: "Checks: " + (it.st.verifySummary || "") + "\n\nAcceptance: " + acceptanceSummary(cfg, it),
      }),
    ])
  )[0];
  if (!r.ok) {
    stopIssue(it, "the merge step failed", r.error);
  } else if (r.merged) {
    it.closed = true;
    it.outcome = "merged";
  } else if (r.reason === "queued") {
    // An older PR is ready too and merges first (decision merge-order). Stay at merge;
    // if it lands first, the next merge attempt reports "behind" and this one rebases.
    const note = "merge waits for #" + r.waitingFor + " (older PR #" + r.waitingForPr + ")";
    if (((it.st.log || []).slice(-1)[0] || "").indexOf(note) < 0) logEvent(it, note);
  } else if (r.reason === "behind" || r.reason === "conflict") {
    // This head passed every check, acceptance and the security review.
    it.st.passedSha = it.st.verifiedSha;
    it.st.stage = "sync";
    logEvent(it, "merge deferred: " + r.reason + "; will rebase next sweep");
  } else {
    stopIssue(it, "GitHub refused the merge", r.reason);
  }
}
await flushStops();

// ---------- parents of split issues ----------

const parentResults = await opsAll(sweep.parents.map((n) => opsSpec("p" + n + "-close", "close-parent", { number: n })));

// ---------- release an unfinished issue for the next sweep ----------

if (item && !item.closed && item.st) await opsAll([opsSpec("i" + item.n + "-release", "release", { number: item.n, state: item.st })]);
// A closed issue can still hold queued comments; post them with an op that does nothing else.
if (item && item.outbox.length) await opsAll([opsSpec("i" + item.n + "-post", "post", { number: item.n })]);

return {
  sweep: SWEEP,
  lane: LANE,
  repo: cfg.repo,
  waiting: sweep.waiting,
  abandoned: abandoned,
  items: item
    ? [
        {
          issue: item.n,
          pr: item.st ? item.st.pr : null,
          stage: item.st ? item.st.stage : null,
          outcome: item.outcome || "in-progress",
          reason: item.reason || null,
          allocatedTokens: item.st ? item.st.allocated : null,
        },
      ]
    : [],
  parentsClosed: parentResults.filter((r) => r.ok && r.closed).length,
};
