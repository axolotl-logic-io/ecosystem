// @ts-check
// The finalizer's rebase and retest (#422) against local git and the fake gh:
// an issue's branch pushed to a local origin, a base that has moved past it
// (or conflicts with it, or hasn't moved), and the role registered for
// `merge` run as a job runs it, with merge, sync-base and verify through the
// ops CLI. GitHub shows the PR's head as origin's branch. CI is scripted,
// since ci-status waits on CI that is still running. Saves go to an
// in-memory store, as the state comment would hold them, and a stop saves
// its own state there. A job may be killed right after one op's work, and the
// next job then starts from the store.
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("finalizer-rebase");
// After the fixture, which sets the pipeline root the modules read.
const { roleOf } = await import("../src/roles/registry.ts");
const { STATE } = await import("../src/state.ts");
const { JOB_CONFIG, roleContext } = await import("./role-context-fixtures.mjs");

/** @import { Effects, OpEffect, Outcome } from "../src/job/run-step.ts" */
/** @import { RunEnd } from "../src/job/runner.ts" */
/** @import { State } from "../src/state.ts" */

const PR_OFFSET = 100;
const PASS = "pass";
/** @type {Outcome} */
const OK_SAVE = { ok: true, name: "ok", reply: { ok: true } };

/**
 * One issue's world: its number, PR, config file, the head its branch was
 * verified at, the base's head, the store and every op request and gh write.
 * @typedef {object} Place
 * @property {number} issue
 * @property {number} pr
 * @property {string} config
 * @property {string} verified
 * @property {string} base
 * @property {string} mergeable
 * @property {State} saved
 * @property {{ op: string, payload: Readonly<Record<string, unknown>>, minutes: number | undefined }[]} sent
 * @property {string[][]} ghCalls
 */

/**
 * @typedef {object} RebaseSetup
 * @property {number} issue the issue, one per test, whose branch is fresh
 * @property {"behind" | "current" | "conflict" | "same"} base how the base stands to the branch ("same": it has gained the branch's own change)
 * @property {string} [test] the repo's test command (default "true")
 * @property {Record<string, unknown>} [start] fields over the state at merge
 * @property {string} [mergeable] GitHub's mergeable for the PR (default MERGEABLE)
 * @property {Record<string, unknown>} [config] settings over the repo config's
 */

/**
 * The branch, pushed and verified, and the base as `setup` says.
 * @param {RebaseSetup} setup @returns {Place}
 */
function placeOf(setup) {
  const { issue } = setup;
  const verified = fx.startBranch(issue, `f${issue}`, "branch");
  let base = fx.originRef("integration");
  if (setup.base === "behind") {
    base = fx.advanceBase(`b${issue}`, "base");
  } else if (setup.base === "conflict") {
    base = fx.advanceBase(`f${issue}`, "base");
  } else if (setup.base === "same") {
    base = fx.advanceBase(`f${issue}`, "branch");
  }
  const commands = { test: setup.test ?? "true" };
  const config = fx.configWith(`config-${issue}.json`, {
    commands,
    ...setup.config,
  });
  const pr = PR_OFFSET + issue;
  /** @type {State} */
  const saved = {
    version: 1,
    number: issue,
    stage: "merge",
    depth: 0,
    lease: { holder: "job" },
    pr,
    headSha: verified,
    verifiedSha: verified,
    verifySummary: "test: exit 0",
    findings: [],
    log: [],
    ...setup.start,
  };
  const mergeable = setup.mergeable ?? "MERGEABLE";
  return {
    issue,
    pr,
    config,
    verified,
    base,
    mergeable,
    saved,
    sent: [],
    ghCalls: [],
  };
}

/** @param {Place} place @returns {import("./fake-gh.mjs").GhReply[]} GitHub's view of the PR: open at origin's branch */
function prView(place) {
  const view = {
    headRefOid: fx.originRef(`agent/issue-${place.issue}`),
    state: "OPEN",
    mergeable: place.mergeable,
    mergeStateStatus: "CLEAN",
    isDraft: false,
  };
  return [{ when: "pr view", stdout: JSON.stringify(view) }];
}

/** @param {unknown} reply @returns {Outcome} */
function outcomeOf(reply) {
  if (
    typeof reply === "object" &&
    reply !== null &&
    "ok" in reply &&
    reply.ok === true
  ) {
    return { ok: true, name: "ok", reply };
  }
  return { ok: false, error: JSON.stringify(reply) };
}

/** @param {string} status @returns {Record<string, unknown>} ci-status's reply */
function ciReply(status) {
  if (status === "fail") {
    return { ok: true, status, failing: ["build"], logPath: "ci.log" };
  }
  return { ok: true, status };
}

/**
 * An op the role sends, through the ops CLI, or scripted for ci-status,
 * stop and post.
 * @param {Place} place @param {OpEffect} effect @param {string[]} ci
 * @returns {Outcome}
 */
function opOf(place, effect, ci) {
  /** @type {Record<string, unknown>} */
  const payload = { ...effect.payload, number: place.issue };
  place.sent.push({ op: effect.op, payload, minutes: effect.minutes });
  switch (effect.op) {
    case "ci-status":
      return outcomeOf(ciReply(ci.shift() ?? PASS));
    case "stop": {
      const { state, code } = payload;
      place.saved = {
        ...STATE.parse(state),
        stage: "stopped",
        stopCode: String(code),
      };
      return outcomeOf({ ok: true });
    }
    case "post":
      return outcomeOf({ ok: true });
    default: {
      fx.fakeGh.reply(prView(place));
      const out = fx.ask({ op: effect.op, ...payload }, place.config);
      place.ghCalls.push(...fx.fakeGh.calls());
      return outcomeOf(JSON.parse(out));
    }
  }
}

/**
 * What one job meets: CI's statuses, in turn; the op it dies right after;
 * the op whose request fails once with `error`, without running; and the op
 * after which the base moves on again.
 * @typedef {object} JobScript
 * @property {string[]} [ci]
 * @property {string} [killAfter]
 * @property {{ op: string, error: string } | undefined} [failOnce]
 * @property {string | undefined} [moveBaseAfter]
 */

/**
 * The op's outcome as `job` scripts it: failed once, or run, with the base
 * moved after it when `job` says so.
 * @param {Place} place @param {OpEffect} effect
 * @param {JobScript & { ci: string[] }} job @returns {Outcome}
 */
function scriptedOp(place, effect, job) {
  const { failOnce } = job;
  if (failOnce !== undefined && failOnce.op === effect.op) {
    job.failOnce = undefined;
    const { op, payload, minutes } = effect;
    place.sent.push({ op, payload, minutes });
    return { ok: false, error: failOnce.error };
  }
  const outcome = opOf(place, effect, job.ci);
  if (effect.op === job.moveBaseAfter) {
    job.moveBaseAfter = undefined;
    place.base = fx.advanceBase(`m${place.issue}`, "moved");
  }
  return outcome;
}

/**
 * One job at the store's stage. With `killAfter`, the job dies right after
 * that op's work, before the role sees its reply, and ends "killed".
 * @param {Place} place @param {JobScript} [job]
 * @returns {Promise<RunEnd | "killed">}
 */
async function runJob(place, job = {}) {
  const role = roleOf("merge");
  if (role === undefined) {
    throw new Error("no role is registered for merge");
  }
  const scripted = { ...job, ci: [...(job.ci ?? [])] };
  /** @type {PromiseWithResolvers<"killed">} */
  const { promise: killed, resolve } = Promise.withResolvers();
  /** @type {Omit<Effects, "check">} */
  const effects = {
    op: (effect) => {
      const outcome = scriptedOp(place, effect, scripted);
      if (effect.op === job.killAfter) {
        resolve("killed");
        return new Promise(() => undefined);
      }
      return Promise.resolve(outcome);
    },
    session: () => Promise.reject(new Error("the finalizer runs no session")),
    sessions: () => Promise.reject(new Error("the finalizer runs no sessions")),
    usage: () => Promise.resolve(),
    save: (state) => {
      place.saved = structuredClone(state);
      return Promise.resolve(OK_SAVE);
    },
    clock: () => new Date("2026-10-18T12:00:00Z"),
    stopping: () => null,
    step: () => undefined,
    moved: () => undefined,
  };
  const context = { ...roleContext(), issue: place.issue };
  const entry = { stage: "merge", saved: place.saved, context };
  return await Promise.race([role.run(entry, effects, JOB_CONFIG), killed]);
}

/** @param {Place} place @returns {string[]} the ops sent, in order */
function opsSent(place) {
  return place.sent.map(({ op }) => op);
}

/** @param {Place} place @param {string} op @returns {Readonly<Record<string, unknown>>[]} */
function sentTo(place, op) {
  return place.sent.filter((s) => s.op === op).map((s) => s.payload);
}

/** @param {Place} place @param {string} op @returns {(number | undefined)[]} the minutes each `op` request was given */
function minutesOf(place, op) {
  return place.sent.filter((s) => s.op === op).map((s) => s.minutes);
}

/** @param {Place} place @returns {string[]} the heads `gh pr merge` merged at */
function mergedAt(place) {
  return place.ghCalls
    .filter(([cmd, sub]) => cmd === "pr" && sub === "merge")
    .map((args) => args.at(-1) ?? "");
}

/** @param {Place} place @returns {string} the issue's branch on origin */
function branchHead(place) {
  return fx.originRef(`agent/issue-${place.issue}`);
}

/** @param {Place} place @returns {boolean} whether origin's branch contains the base's head */
function containsBase(place) {
  const branch = branchHead(place);
  const origin = `${fx.root}/origin.git`;
  const ancestor = `merge-base --is-ancestor ${place.base} ${branch}`;
  return (
    fx.sh(`git --git-dir ${origin} ${ancestor} && echo yes || true`) === "yes"
  );
}

export {
  branchHead,
  containsBase,
  fx,
  mergedAt,
  minutesOf,
  opsSent,
  placeOf,
  runJob,
  sentTo,
};
