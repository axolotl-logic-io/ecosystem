// @ts-check
// The Reviewer's hardening script for its tests: a draft at review whose
// every op succeeds, a hardening session that says it is done, and a fake
// context reading the revision before the session and after the push.
import {
  current,
  fakeContext,
  HEAD,
  issueState,
  PR,
} from "./reviewer-and-merge-role-kit.mjs";

const VERIFIED = { pass: true, headSha: HEAD, changedFiles: [], checks: [] };
const PUSHED = { headSha: HEAD, codeChanged: true };
const READY = { pr: PR, ready: true };

/** @type {import("../src/job/role-context.ts").SessionResult} */
const HARDENED = {
  ok: true,
  reply: { outcome: "done", summary: "Added an edge-case test" },
};

/**
 * @param {{
 *   state?: Partial<import("../src/state.ts").IssueState>,
 *   before?: unknown, after?: unknown,
 *   ops?: Record<string, unknown[]>,
 *   sessions?: import("../src/job/role-context.ts").SessionResult[],
 *   gherkin?: import("../src/gherkin-comment.ts").GherkinComment | null,
 *   config?: Partial<import("../src/config.ts").Config>,
 * }} [script]
 */
function hardening(script = {}) {
  return fakeContext({
    stage: "review",
    state: issueState({ stage: "review", verifiedSha: null, ...script.state }),
    gherkin: script.gherkin,
    config: script.config,
    ops: {
      "current-revision": [
        script.before ?? current(),
        script.after ?? current(),
      ],
      verify: [VERIFIED],
      push: [PUSHED],
      "ready-pr": [READY],
      ...script.ops,
    },
    sessions: script.sessions ?? [HARDENED],
  });
}

export { HARDENED, hardening, PUSHED, READY, VERIFIED };
