// @ts-check
// The spec writer role on the runner's fake effects (runner-test-kit.mjs):
// issue #7 as the job claims it at spec, and fakes of the ops the role sends,
// each safe to run twice as the real op is. `post` writes each keyed comment
// once through the fake gh and edits it after; `start-pr` opens PR #42 once
// and sets its body after; `split` opens the sub-issues once; `close-pr`
// closes the PR once; `ask` and `stop` save their own state and set their
// labels; `ask` writes as the real op does, from its payload's `state`. A killed run starts again only while the claim would: at spec.
import { spawnSync } from "node:child_process";

/** @import { Act, OpFake } from "./runner-test-kit.mjs" */
/** @import { State } from "../src/state.ts" */

const ISSUE = 7;
const PR = 42;
const SPEC_FILE = "/runs/issue-7/spec.md";
// The time the fake `ask` saves as the questions' time.
const ASKED_AT = "2026-10-18T04:26:32.000Z";
/** @type {Act["reply"]} */
const DONE = { ok: true, name: "ok", reply: { ok: true } };

/** @param {Record<string, unknown>} [fields] @returns {State} issue #7 claimed at spec */
function specState(fields = {}) {
  return {
    version: 1,
    number: ISSUE,
    stage: "spec",
    depth: 0,
    lease: { holder: "job" },
    ...fields,
  };
}

/** @param {unknown} value @returns {readonly unknown[]} */
function listOf(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function recordOf(value) {
  if (typeof value === "object" && value !== null) {
    return { ...value };
  }
  return {};
}

/** @param {readonly string[]} args */
function gh(args) {
  spawnSync("gh", args);
}

/** @type {OpFake} */
function post(store, payload) {
  return {
    write: () => {
      const { comments } = payload;
      for (const item of listOf(comments)) {
        const { key, body } = recordOf(item);
        const marker = `<!-- issue-pipeline:${ISSUE}:${String(key)} -->`;
        const text = `${String(body)}\n${marker}`;
        if (store.markers.has(marker)) {
          gh(["api", "-X", "PATCH", "repos/o/r/issues/comments/1", "-f", text]);
        } else {
          gh(["issue", "comment", String(ISSUE), "--body", text]);
          store.markers.add(marker);
        }
      }
    },
    reply: DONE,
  };
}

/** @type {OpFake} */
function startPr(store, payload) {
  return {
    write: () => {
      const { body } = payload;
      if (store.markers.has("pr")) {
        gh(["pr", "edit", String(PR), "--body", String(body)]);
      } else {
        gh(["pr", "create", "--draft", "--body", String(body)]);
        store.markers.add("pr");
      }
    },
    reply: { ok: true, name: "ok", reply: { ok: true, pr: PR, headSha: "h1" } },
  };
}

/** @type {OpFake} */
function closePr(store, { pr }) {
  return {
    write: () => {
      if (!store.markers.has("pr-closed")) {
        gh(["pr", "close", String(pr)]);
        store.markers.add("pr-closed");
      }
    },
    reply: { ok: true, name: "ok", reply: { pr, closed: true } },
  };
}

/** @type {OpFake} */
function split(store, { subIssues }) {
  return {
    write: () => {
      if (!store.markers.has("split")) {
        for (const sub of listOf(subIssues)) {
          const { title } = recordOf(sub);
          gh(["issue", "create", "--title", String(title)]);
        }
        store.markers.add("split");
      }
      store.labels.add("agent:split");
    },
    reply: DONE,
  };
}

/** @type {OpFake} as the real op (src/ops/ask.ts) writes: the payload's state at triage, asked at ASKED_AT, with no lease (#457) */
function ask(store, payload) {
  return {
    write: () => {
      const { state } = payload;
      store.saved = {
        ...recordOf(state),
        stage: "triage",
        questionsAt: ASKED_AT,
        lease: null,
      };
      store.labels.add("agent:needs-info");
    },
    reply: DONE,
  };
}

/** @type {OpFake} */
function stop(store, payload) {
  return {
    write: () => {
      const { reason, code } = payload;
      store.saved = { ...store.saved, stage: "stopped", stopReason: reason };
      store.labels.add(`agent:stopped-${String(code)}`);
    },
    reply: DONE,
  };
}

/** @type {OpFake} */
function saveSpec() {
  return {
    reply: { ok: true, name: "ok", reply: { ok: true, specFile: SPEC_FILE } },
  };
}

const SPEC_OPS = {
  post,
  "start-pr": startPr,
  "close-pr": closePr,
  split,
  ask,
  stop,
  "save-spec": saveSpec,
};

/** @param {State} saved @returns {boolean} whether the claim would start a killed run again */
function restarts(saved) {
  return saved.stage === "spec";
}

/** @param {readonly string[][]} writes @param {string} cmd @param {string} sub @returns {number} how many of `writes` are `gh <cmd> <sub>` */
function countOf(writes, cmd, sub) {
  return writes.filter(([c, s]) => c === cmd && s === sub).length;
}

/** @param {readonly string[][]} writes @returns {number} the `## Spec` comments posted */
function specPosts(writes) {
  const marker = `<!-- issue-pipeline:${ISSUE}:spec -->`;
  return writes.filter(
    ([cmd, sub, ...rest]) =>
      cmd === "issue" && sub === "comment" && rest.join(" ").includes(marker),
  ).length;
}

export {
  ASKED_AT,
  countOf,
  ISSUE,
  PR,
  restarts,
  SPEC_FILE,
  SPEC_OPS,
  specPosts,
  specState,
};
