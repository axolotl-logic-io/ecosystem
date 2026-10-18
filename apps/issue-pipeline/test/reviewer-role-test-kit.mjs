// @ts-check
// The reviewer role's script for its tests: a prepared review at the head,
// a reviewer reply, and a fake context reading the revision before and after
// the session.
import {
  current,
  fakeContext,
  HEAD,
  issueState,
} from "./reviewer-and-merge-role-kit.mjs";

const BLOCKING_LINE = 12;

const PREPARED = {
  headSha: HEAD,
  diffPath: "/run/review-r1/diff.patch",
  bundlePath: "/run/review-r1/bundle.md",
  changedFiles: ["src/chat.ts", "wiki/Chats.md"],
};

const BLOCKING = {
  severity: /** @type {const} */ ("blocking"),
  text: "The list isn't sorted.",
  path: "src/chat.ts",
  line: BLOCKING_LINE,
};

/**
 * @param {Partial<import("../src/roles/replies.ts").ReviewerReply>} [reply]
 * @returns {import("../src/job/role-context.ts").SessionResult}
 */
function verdict(reply = {}) {
  return {
    ok: true,
    reply: {
      verdict: "approve",
      summary: "Does what the Gherkin says.",
      findings: [],
      security: null,
      ...reply,
    },
  };
}

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   before?: unknown, after?: unknown, prepared?: unknown,
 *   result?: import("../src/job/role-context.ts").SessionResult,
 *   gherkin?: import("../src/gherkin-comment.ts").GherkinComment | null,
 * }} [script]
 */
function review(script = {}) {
  return fakeContext({
    stage: "review",
    state: issueState({ stage: "review", verifiedSha: HEAD, ...script.state }),
    gherkin: script.gherkin,
    ops: {
      "current-revision": [
        script.before ?? current(),
        script.after ?? current(),
      ],
      "prepare-review": [script.prepared ?? PREPARED],
    },
    sessions: [script.result ?? verdict()],
  });
}

export { BLOCKING, BLOCKING_LINE, PREPARED, review, verdict };
