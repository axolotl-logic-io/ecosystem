// @ts-check
// The finalizer role (#416) on the runner's fake effects (runner-test-kit.mjs):
// issue #7 as the job claims it at merge, the role as the registry gives it
// for `merge`, and fakes of the ops it sends, each payload kept in `sent`.
// The merge fake does what the merge op promises (merge-op.test.mjs): a PR
// GitHub already shows merged gets the bookkeeping only, and any other
// merge calls `gh pr merge` once through the fake gh; both write the
// issue's state at done, or at publish when the wiki wasn't published, and
// label it agent:merged. finish-wiki does the same with no PR. The wiki's
// rebase conflicts until finish-wiki-sync resolves it. `stop` saves its own
// state and labels the issue with its code. A killed run starts again only
// while the claim would start the merge stage: at merge.
import { spawnSync } from "node:child_process";
import { roleOf } from "../src/roles/registry.ts";
import { JOB_CONFIG, roleContext } from "./role-context-fixtures.mjs";
import { killAt } from "./runner-test-kit.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { SessionEffect } from "../src/roles/machine.ts" */
/** @import { State } from "../src/state.ts" */
/** @import { SweepConfig } from "../src/workflow/stages/types.ts" */
/** @import { Kill, OpFake, RoleRun, Store, WorldOptions } from "./runner-test-kit.mjs" */

const ISSUE = 7;
const PR = 42;
const VERIFIED = "v1v1v1v1v1v1";
const WIKI = "/jobs/issue-7-merge/wiki";
// The store's markers: GitHub shows the PR merged; the wiki's rebase is
// resolved.
const PR_MERGED = "github:pr-merged";
const WIKI_RESOLVED = "wiki:resolved";
const MERGED_LABEL = "agent:merged";

/**
 * @typedef {object} FinalizerSetup
 * @property {Record<string, unknown>} [start] fields over the state at merge
 * @property {Partial<SweepConfig>} [cfg] fields over the repo config
 * @property {boolean} [wiki] whether the claim has a wiki checkout
 * @property {readonly number[] | null} [mergeQueue] the orchestrator's queue
 * @property {Record<string, unknown>} [merge] the merge op's reply when it doesn't merge
 * @property {string} [mergeError] the merge op's failure
 * @property {boolean} [published] whether merging publishes the wiki (default true)
 * @property {boolean} [prMerged] whether GitHub shows the PR merged before the run
 * @property {boolean} [wikiConflict] whether the wiki's rebase conflicts
 * @property {Record<string, unknown>} [finishWikiSync] the finish-wiki-sync reply
 * @property {Record<string, unknown>} [wikiCheck] the wiki-check reply
 * @property {readonly Outcome[]} [resolvers] what each resolver session comes to, in turn; the last repeats
 */

/** @typedef {{ op: string, payload: Readonly<Record<string, unknown>> }} Sent */

/**
 * Runs the role registered for `merge`.
 * @param {Parameters<RoleRun>[0]} entry @param {Parameters<RoleRun>[1]} effects
 * @returns {ReturnType<RoleRun>}
 */
function runFinalizer(entry, effects) {
  const role = roleOf("merge");
  if (role === undefined) {
    throw new Error("no role is registered for merge");
  }
  return role.run(entry, effects, JOB_CONFIG);
}

/** @param {Record<string, unknown>} [fields] @returns {State} */
function mergeState(fields = {}) {
  return {
    version: 1,
    number: ISSUE,
    stage: "merge",
    depth: 0,
    lease: { holder: "job" },
    pr: PR,
    headSha: VERIFIED,
    verifiedSha: VERIFIED,
    verifySummary: "tests pass",
    findings: [],
    log: [],
    ...fields,
  };
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function recordOf(value) {
  if (typeof value === "object" && value !== null) {
    return { ...value };
  }
  return {};
}

/** @param {string} op @param {Record<string, unknown>} reply @returns {Outcome} */
function okReply(op, reply) {
  return {
    ok: true,
    name: "ok",
    reply: { ok: true, op, posted: [], ...reply },
  };
}

/** @param {Store} store @param {unknown} state @param {boolean} published */
function closeMerged(store, state, published) {
  let stage = "done";
  if (!published) {
    stage = "publish";
  }
  store.saved = { ...mergeState(), ...recordOf(state), stage, lease: null };
  store.labels.add(MERGED_LABEL);
}

/** @param {FinalizerSetup} setup @returns {OpFake} */
function mergeFake(setup) {
  const published = setup.published ?? true;
  return (store, payload) => {
    const { state } = payload;
    if (setup.mergeError !== undefined) {
      return { reply: { ok: false, error: setup.mergeError } };
    }
    if (setup.prMerged === true || store.markers.has(PR_MERGED)) {
      return {
        write: () => closeMerged(store, state, published),
        reply: okReply("merge", { merged: true, byHand: true, published }),
      };
    }
    if (setup.merge !== undefined) {
      return { reply: okReply("merge", setup.merge) };
    }
    return {
      write: () => {
        spawnSync("gh", ["pr", "merge", String(PR), "-R", "o/r", "--squash"]);
        store.markers.add(PR_MERGED);
        closeMerged(store, state, published);
      },
      reply: okReply("merge", { merged: true, published }),
    };
  };
}

/** @type {OpFake} */
function finishWiki(store, payload) {
  const { state } = payload;
  return {
    write: () => closeMerged(store, state, true),
    reply: okReply("finish-wiki", { merged: true, published: true }),
  };
}

/** @param {FinalizerSetup} setup @returns {OpFake} */
function wikiSync(setup) {
  return (store) => {
    if (setup.wikiConflict === true && !store.markers.has(WIKI_RESOLVED)) {
      const conflict = { conflict: true, conflicts: ["Home.md"] };
      const reply = { ...conflict, baseSha: "w0", branch: "master" };
      return { reply: okReply("wiki-sync", reply) };
    }
    const clean = { conflict: false, changed: false, headSha: "w1" };
    return { reply: okReply("wiki-sync", clean) };
  };
}

/** @param {FinalizerSetup} setup @returns {OpFake} */
function finishWikiSync(setup) {
  return (store, payload) => {
    const reply = setup.finishWikiSync ?? { resolved: true, headSha: "w2" };
    const { abort } = payload;
    const { resolved } = reply;
    const resolves = abort !== true && resolved === true;
    return {
      write: () => {
        if (resolves) {
          store.markers.add(WIKI_RESOLVED);
        }
      },
      reply: okReply("finish-wiki-sync", reply),
    };
  };
}

/** @type {OpFake} */
function stop(store, payload) {
  return {
    write: () => {
      const { state, reason, code } = payload;
      const stopped = { stage: "stopped", stopReason: reason };
      store.saved = { ...mergeState(), ...recordOf(state), ...stopped };
      store.labels.add(`agent:stopped-${String(code)}`);
    },
    reply: okReply("stop", {}),
  };
}

/**
 * The op fakes for `setup`, each recording its payload in `sent`.
 * @param {FinalizerSetup} setup @param {Sent[]} sent
 * @returns {Record<string, OpFake>}
 */
function opsOf(setup, sent) {
  const check = setup.wikiCheck ?? { pass: true, checks: [] };
  /** @type {Record<string, OpFake>} */
  const fakes = {
    merge: mergeFake(setup),
    "finish-wiki": finishWiki,
    "wiki-sync": wikiSync(setup),
    "wiki-check": () => ({ reply: okReply("wiki-check", check) }),
    "finish-wiki-sync": finishWikiSync(setup),
    stop,
    post: () => ({ reply: okReply("post", {}) }),
  };
  return Object.fromEntries(
    Object.entries(fakes).map(([op, fake]) => [
      op,
      /** @type {OpFake} */
      (store, payload) => {
        sent.push({ op, payload });
        return fake(store, payload);
      },
    ]),
  );
}

/** @param {string} status @param {string} summary @returns {Outcome} a resolver's reply */
function resolverReply(status, summary) {
  return { ok: true, name: "replied", reply: { status, summary } };
}

const FIXED = resolverReply("fixed", "Kept both sides of Home.md.");

/**
 * The world for a finalizer run; `sessions` gets each session's effect.
 * @param {FinalizerSetup} setup @param {Sent[]} sent @param {SessionEffect[]} sessions
 * @returns {WorldOptions}
 */
function finalizerWorld(setup, sent, sessions) {
  const mergeQueue = setup.mergeQueue ?? null;
  const context = { ...roleContext(setup.cfg), mergeQueue };
  if (setup.wiki === true) {
    context.paths = { ...context.paths, wiki: WIKI };
  }
  const resolvers = setup.resolvers ?? [FIXED];
  return {
    start: () => mergeState(setup.start),
    context,
    session: (effect) => {
      sessions.push(effect);
      const turn = Math.min(sessions.length, resolvers.length) - 1;
      return resolvers[turn] ?? FIXED;
    },
    ops: opsOf(setup, sent),
    // The claim starts the merge stage again only at merge.
    restarts: (saved) => saved.stage === "merge",
  };
}

/**
 * A finalizer run killed at `kill`, or never: the runner kit's result with
 * every op payload sent and every session's effect.
 * @param {FinalizerSetup} [setup] @param {Kill} [kill]
 */
async function finalize(setup, kill) {
  /** @type {Sent[]} */
  const sent = [];
  /** @type {SessionEffect[]} */
  const sessions = [];
  const options = finalizerWorld(setup ?? {}, sent, sessions);
  const run = await killAt(runFinalizer, kill, options);
  return { ...run, sent, sessions };
}

/** @param {Kill} kill @param {FinalizerSetup} [setup] */
function killedFinalize(kill, setup = {}) {
  return finalize(setup, kill);
}

/** @param {readonly string[][]} writes @returns {number} the `gh pr merge` calls */
function prMerges(writes) {
  return writes.filter(([cmd, sub]) => cmd === "pr" && sub === "merge").length;
}

/** @param {{ sent: Sent[] }} run @param {string} op @returns {Readonly<Record<string, unknown>>[]} its payloads */
function sentTo(run, op) {
  return run.sent.filter((entry) => entry.op === op).map((e) => e.payload);
}

/** @param {{ sent: Sent[] }} run @returns {string[]} the ops sent, in order */
function opsSent(run) {
  return run.sent.map((entry) => entry.op);
}

export {
  FIXED,
  finalize,
  killedFinalize,
  MERGED_LABEL,
  mergeState,
  opsSent,
  prMerges,
  resolverReply,
  sentTo,
  VERIFIED,
};
