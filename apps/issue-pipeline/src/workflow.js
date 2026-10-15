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
// Every stage runs on a step machine: a stage is a sync `next` in
// src/workflow/stages/, run through the stage dispatch by a loop that does all
// its awaiting. The loop runs four times: after the claim for triage (#178) and
// spec, implement and open-pr (#188), after open-pr for review and the fix
// rounds (#179), after fix for sync and checks (#180), and after checks for
// accept, security and merge (#189).

const {
  by,
  byStep,
  chargeSession,
  clip,
  closeParentLaunches,
  findingLines,
  noteEvent,
  parentsClosed,
  practicesNote,
  preamble,
  lenses: LENSES,
  reviewSchema: REVIEW_SCHEMA,
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
// How many times a sweep may begin a stage on the step machine (default 1):
// implement runs once more to continue from a handoff.
const STAGE_PASSES = { implement: 2 };
// The stages the sweep saves the issue's state before it first begins.
const SAVE_BEFORE = ["spec", "implement"];

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

// Whether the issue's next stage fits under the spawn cap.
function hasRoom(stage) {
  // Keep room for a release or stop op and a final comment post, plus parent closing.
  const reserve = 3 * (item ? 1 : 0) + sweep.parents.length + 1;
  return spawned + STAGE_SPAWNS[stage] + reserve <= SPAWN_LIMIT;
}

// Whether the issue's next stage fits under the spawn cap. If not, it is held.
function fits(stage) {
  if (hasRoom(stage)) return true;
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
  hasRoom,
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
    held: item.held === true,
    rebasedOnly: item.rebasedOnly === true,
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
  item.held = step.state.held;
  item.rebasedOnly = step.state.rebasedOnly;
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
      by: by(SPEC_META, result, launch.role || launch.name),
    };
  });
}

// The open issue's stage, its machine and how often it has begun this sweep,
// or null if the stage isn't one of `stages` or isn't on the step machine.
function stageMachine(stages) {
  if (!item || item.closed) {
    return null;
  }
  const { stage } = item.st;
  if (!stages.includes(stage) || !Object.hasOwn(STAGES, stage)) {
    return null;
  }
  const { [stage]: machine } = STAGES;
  if (!machine) {
    return null;
  }
  const { [stage]: runs = 0 } = stagesRun;
  return { stage, machine, runs };
}

function passesOf(stage) {
  const { [stage]: passes = 1 } = STAGE_PASSES;
  return passes;
}

// The save of the issue's state before its stage first begins, if the stage
// is one the sweep saves before. It comes before the spawn-cap check, so a
// held issue is saved too.
function savesBeforeStage(stages) {
  const current = stageMachine(stages);
  if (!(current && current.runs === 0 && SAVE_BEFORE.includes(current.stage))) {
    return [];
  }
  return saveOf(item);
}

// The issue's stage machine and its first step, if the stage is one of
// `stages`, is on the step machine, hasn't used its passes this sweep (or
// asked to go again) and fits under the spawn cap.
function beginStage(stages) {
  const current = stageMachine(stages);
  if (!(current && current.runs < passesOf(current.stage) && take(current.stage))) {
    return null;
  }
  const { stage, machine, runs } = current;
  stagesRun[stage] = runs + 1;
  const step = machine.next(stageState("begin", null), STAGE_CONTEXT, []);
  return { machine, step };
}

const BUILD_STAGES = ["triage", "spec", "implement", "open-pr"];
await opsAll(savesBeforeStage(BUILD_STAGES));
let stageRun = beginStage(BUILD_STAGES);
while (stageRun) {
  const specs = applyStep(stageRun.step);
  if (stageRun.step.done) {
    await opsAll(savesBeforeStage(BUILD_STAGES));
    stageRun = beginStage(BUILD_STAGES);
  } else {
    const { machine, step } = stageRun;
    const results = launchResults(step.launches, await spawnAll(specs));
    const state = stageState(step.state.phase, step.state.carry);
    stageRun.step = machine.next(state, STAGE_CONTEXT, results);
  }
}
// Still in implement after both passes, and not held: it has used its continuation.
if (at("implement") && !item.held) stopIssue(item, "implementation did not finish within its sessions");
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

// ---------- sync with base, then checks (local verify + CI, CI-fix rounds) ----------
// Both run on the step machine (stages/sync.ts, stages/checks.ts).

stageRun = beginStage(["sync", "checks"]);
while (stageRun) {
  const specs = applyStep(stageRun.step);
  if (stageRun.step.done) {
    stageRun = beginStage(["sync", "checks"]);
  } else {
    const { machine, step } = stageRun;
    const results = launchResults(step.launches, await spawnAll(specs));
    const state = stageState(step.state.phase, step.state.carry);
    stageRun.step = machine.next(state, STAGE_CONTEXT, results);
  }
}
await flushStops();

// ---------- acceptance, the security review and merge ----------
// All three run on the step machine (stages/accept.ts, stages/security.ts,
// stages/merge.ts).

stageRun = beginStage(["accept", "security", "merge"]);
while (stageRun) {
  const specs = applyStep(stageRun.step);
  if (stageRun.step.done) {
    stageRun = beginStage(["accept", "security", "merge"]);
  } else {
    const { machine, step } = stageRun;
    const results = launchResults(step.launches, await spawnAll(specs));
    const state = stageState(step.state.phase, step.state.carry);
    stageRun.step = machine.next(state, STAGE_CONTEXT, results);
  }
}
await flushStops();

// ---------- parents of split issues ----------

const parentResults = await opsAll(closeParentLaunches(sweep.parents).map((l) => opsSpec(l.name, l.op, l.payload)));

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
  parentsClosed: parentsClosed(parentResults),
};
