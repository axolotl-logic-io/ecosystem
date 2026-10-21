// @ts-check
// Real merge-controller abort/retry paths over local repos; only the model is
// fake. The world's rebase is already stopped on its conflict, so the first
// sync-base reports that conflict; later ones run the real op.
import { headOf, ISSUE } from "./pipeline-commit-test-kit.mjs";
import { finish, leaveResolution } from "./sync-retention-test-kit.mjs";

const { syncOps } = await import("../src/ops/sync.ts");
const { newIssueState } = await import("../src/state.ts");
const INPUTS_LENGTH = 64;

/** @typedef {ReturnType<typeof import("./sync-retention-test-kit.mjs").conflicted>} World */

/** The stopped rebase's conflict, as sync-base reports it. @param {World} w */
function conflictOf(w) {
  return {
    conflict: true,
    changed: false,
    inRebase: true,
    conflicts: [w.file],
    baseSha: headOf(w.dir),
  };
}

/** @param {World} w @param {string[]} ops @param {string} name @param {object} payload */
function syncOperation(w, ops, name, payload) {
  const started = ops.includes("sync-base");
  ops.push(name);
  if (name === "finish-sync") {
    return finish(w, true);
  }
  if (name === "sync-base" && !started) {
    return conflictOf(w);
  }
  if (name === "sync-base") {
    const start = syncOps["sync-base"];
    if (start === undefined) {
      throw new Error("missing sync-base");
    }
    return start(w.scoped, payload);
  }
  throw new Error(`unexpected resolver operation ${name}`);
}

/** @param {World} w @param {boolean} failed @returns {import("../src/job/role-context.ts").SessionResult} */
function modelReply(w, failed) {
  leaveResolution(w);
  if (failed) {
    return { ok: false, transient: false, error: "mock resolver failed" };
  }
  return {
    ok: true,
    reply: { outcome: "cannot-fix", summary: "Cannot finish" },
  };
}

/**
 * @param {World} w
 * @param {boolean} failed
 * @returns {{ ctx: import("../src/job/role-context.ts").RoleContext, ops: string[], saved: import("../src/state.ts").IssueState[] }}
 */
function resolverContext(w, failed) {
  /** @type {string[]} */
  const ops = [];
  /** @type {import("../src/state.ts").IssueState[]} */
  const saved = [];
  const state = {
    ...newIssueState(ISSUE),
    stage: /** @type {const} */ ("merge"),
    branch: w.job.branch,
  };
  /** @type {import("../src/job/role-context.ts").RoleInputs} */
  const inputs = {
    issue: {
      title: "Keep resolver work",
      body: "Preserve work",
      user: { login: "alice" },
    },
    comments: [],
    revision: "a".repeat(INPUTS_LENGTH),
    gherkin: null,
  };
  return {
    ops,
    saved,
    ctx: {
      cfg: w.scoped,
      issue: ISSUE,
      stage: "merge",
      state,
      dirs: { job: w.job.root, repo: w.job.repo },
      issueFile: "local-issue.md",
      mergeQueue: [ISSUE],
      inputs,
      op: async (name, payload) => syncOperation(w, ops, name, payload),
      session: async () => modelReply(w, failed),
      save: (value) => {
        saved.push(value);
        return Promise.resolve();
      },
      post: () => Promise.reject(new Error("unexpected GitHub post")),
    },
  };
}

export { resolverContext };
