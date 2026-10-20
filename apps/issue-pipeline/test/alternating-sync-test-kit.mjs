// @ts-check
// Real ops and rebases with staged-only resolver sessions at each text stop.
import fs from "node:fs";
import path from "node:path";
import { gitlinkSyncFixture } from "./gitlink-sync-test-kit.mjs";

const fixture = await gitlinkSyncFixture("alternating-conflicts");
const { fx, cfg, seed, branch, wikiCommit, stagePin, ask, resolveText } =
  fixture;
const { syncSide } = await import("../src/roles/merge/sync.ts");
const { newIssueState } = await import("../src/state.ts");
const { conflictStages } = await import("../src/rebase.ts");
const { OpsFailure } = await import("../src/job/role-context.ts");

/** @typedef {import("../src/job/role-context.ts").RoleContext} RoleContext */
/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/roles/op-replies.ts").Conflict} Conflict */
/** @typedef {{ n: number; wt: string; original: string; target: string; base: string }} History */
/** @typedef {{ name: string; payload: object; remote: string; saved: number; attempts: number }} SyncOp */
/** @typedef {{ spec: import("../src/job/role-context.ts").SessionSpec; files: string[] }} Resolver */
/** @typedef {{ end: import("../src/roles/writer-session.ts").Step<IssueState>; saves: IssueState[]; sessions: Resolver[]; ops: SyncOp[]; stoppedPicks: string[] }} SyncRun */

/**
 * Each pick is text-only, wiki-only or mixed; the fetched base conflicts on
 * every selected path. Wiki commits are divergent, not ancestor pins.
 * @param {number} n
 * @param {("text" | "wiki" | "mixed")[]} picks
 * @returns {History}
 */
function history(n, picks) {
  fx.advanceBase(`common${n}`, "seed");
  for (const [index, pick] of picks.entries()) {
    if (pick !== "wiki") {
      fx.advanceBase(`text${n}-${index}`, "ancestor");
    }
  }
  const wt = branch(n);
  for (const [index, pick] of picks.entries()) {
    if (pick !== "text") {
      stagePin(wt, wikiCommit(`own${n}-${index}`));
    }
    if (pick === "wiki") {
      fx.sh(`git -C ${wt} commit -qm "Wiki pick ${index}"`);
    } else {
      fx.commitIn(n, `text${n}-${index}`, "mine");
    }
  }
  const original = fx.pushFrom(n);
  for (const [index, pick] of picks.entries()) {
    if (pick !== "wiki") {
      fx.advanceBase(`text${n}-${index}`, "target");
    }
  }
  const target = wikiCommit(`target${n}`);
  stagePin(seed, target);
  const base = fx.advanceBase(`base${n}`, "target");
  return { n, wt, original, target, base };
}

/**
 * The role uses the actual ops boundary. Only the model is replaced: it stages
 * current text, never wiki entries or continuation. Every finish observes the
 * saved cumulative attempt count, and no intermediate result may be pushed.
 * @param {History} h
 * @param {number} max
 * @param {{ initial?: number; first?: Conflict }} [options]
 * @returns {Promise<SyncRun>}
 */
async function resolveHistory(h, max, { initial = 0, first } = {}) {
  /** @type {IssueState[]} */
  const saves = [];
  /** @type {Resolver[]} */
  const sessions = [];
  /** @type {SyncOp[]} */
  const ops = [];
  /** @type {string[]} */
  const stoppedPicks = [];
  /** @param {import("../src/job/role-context.ts").OpName} name @param {object} payload */
  function op(name, payload) {
    ops.push({
      name,
      payload,
      remote: fx.originRef(`agent/issue-${h.n}`),
      saved: saves.at(-1)?.counts.conflictFixes ?? initial,
      attempts: initial + sessions.length,
    });
    const reply = ask(h.n, name, payload);
    if (!reply.ok) {
      throw new OpsFailure(name, 1, reply.error ?? "op failed");
    }
    if (reply.conflict) {
      stoppedPicks.push(fx.sh(`git -C ${h.wt} rev-parse REBASE_HEAD`));
    }
    return Promise.resolve(reply);
  }
  /** @param {import("../src/job/role-context.ts").SessionSpec} spec @returns {Promise<import("../src/job/role-context.ts").SessionResult>} */
  function session(spec) {
    const files = [
      ...new Set(
        conflictStages(h.wt)
          .filter((entry) => entry.mode !== "160000")
          .map((entry) => entry.file),
      ),
    ];
    sessions.push({ spec, files });
    for (const file of files) {
      resolveText(h.wt, file);
    }
    return Promise.resolve({
      ok: true,
      reply: { outcome: "conflict-resolved", summary: "Staged text only" },
    });
  }
  const ctx = resolverContext(h, initial, {
    op,
    session,
    save: (state) => {
      saves.push(state);
      return Promise.resolve();
    },
  });
  /** @type {{ side: "code"; maxConflictFixes: number; first?: Conflict }} */
  const options = { side: "code", maxConflictFixes: max };
  if (first !== undefined) {
    options.first = first;
  }
  const end = await syncSide(ctx, ctx.state, options);
  return { end, saves, sessions, ops, stoppedPicks };
}

/** @param {History} h @param {number} initial @param {Pick<RoleContext, "op" | "session" | "save">} hooks @returns {RoleContext} */
function resolverContext(h, initial, hooks) {
  return {
    cfg,
    issue: h.n,
    stage: "merge",
    state: {
      ...newIssueState(h.n),
      stage: "merge",
      counts: { syncs: 1, conflictFixes: initial },
    },
    dirs: { job: fx.root, repo: h.wt, docs: null },
    issueFile: path.join(fx.root, "issue.md"),
    mergeQueue: null,
    inputs: {
      issue: { title: "Alternating conflicts", body: "", user: { login: "a" } },
      comments: [],
      revision: "inputs",
      gherkin: null,
    },
    ...hooks,
    post: () => Promise.reject(new Error("sync posts no comments")),
  };
}

/** @param {string} wt */
function syncContext(wt) {
  const file = path.resolve(
    wt,
    fx.sh(`git -C ${wt} rev-parse --git-path pipeline-code-sync.json`),
  );
  return fs.readFileSync(file);
}

export { fixture, history, resolveHistory, syncContext };
