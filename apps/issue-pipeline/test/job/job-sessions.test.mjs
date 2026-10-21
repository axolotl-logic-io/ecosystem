// @ts-check
// The sessions each stage job runs (src/job/roles.ts): its one installed
// agent, and only the sessions its stage lists, each with its phase's write
// authority, which is the session's own, never its agent's. The reviewer
// hardens, committing, in review; in merge it integrates, committing, then
// reviews security, only reading. A session the stage doesn't list, such as a
// reviewer session that names no phase, is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { STAGE_AGENTS, sessionRefusalOf } = await import(
  "../../src/job/roles.ts"
);

/** @typedef {import("../../src/stages.ts").Stage} Stage */

const AUTHOR = "issue-pipeline-author";
const IMPLEMENTOR = "issue-pipeline-implementor";
const REVIEWER = "issue-pipeline-reviewer";

test("each stage runs its one agent: the reviewer hardens, integrates and reviews security, so merge runs it too", () => {
  const agents = Object.fromEntries(
    Object.entries(STAGE_AGENTS).map(([stage, { agent, role }]) => [
      stage,
      { agent, role },
    ]),
  );
  assert.deepEqual(agents, {
    author: { agent: AUTHOR, role: "author" },
    implement: { agent: IMPLEMENTOR, role: "implementor" },
    review: { agent: REVIEWER, role: "reviewer" },
    merge: { agent: REVIEWER, role: "reviewer" },
  });
});

/** @typedef {"hardening" | "security-review" | "integration"} Phase */
/** @type {[Stage, string, boolean, Phase | undefined][]} */
const ALLOWED_SESSIONS = [
  ["author", AUTHOR, false, undefined],
  ["implement", IMPLEMENTOR, true, undefined],
  ["review", REVIEWER, true, "hardening"],
  ["merge", REVIEWER, true, "integration"],
  ["merge", REVIEWER, false, "security-review"],
];
/** @type {[Stage, string, boolean, Phase | undefined, RegExp][]} */
const REFUSED_SESSIONS = [
  [
    "author",
    AUTHOR,
    true,
    undefined,
    /unphased session can't set commits true/u,
  ],
  ["implement", IMPLEMENTOR, false, undefined, /can't set commits false/u],
  [
    "review",
    REVIEWER,
    true,
    undefined,
    /review stage runs no unphased session/u,
  ],
  [
    "review",
    REVIEWER,
    false,
    undefined,
    /review stage runs no unphased session/u,
  ],
  [
    "review",
    REVIEWER,
    false,
    "hardening",
    /hardening session can't set commits false/u,
  ],
  [
    "review",
    REVIEWER,
    false,
    "security-review",
    /review stage runs no security-review session/u,
  ],
  [
    "review",
    REVIEWER,
    true,
    "integration",
    /review stage runs no integration session/u,
  ],
  ["merge", REVIEWER, true, undefined, /merge stage runs no unphased session/u],
  [
    "merge",
    REVIEWER,
    false,
    undefined,
    /merge stage runs no unphased session/u,
  ],
  [
    "merge",
    REVIEWER,
    true,
    "hardening",
    /merge stage runs no hardening session/u,
  ],
  [
    "merge",
    REVIEWER,
    false,
    "integration",
    /integration session can't set commits false/u,
  ],
  [
    "merge",
    REVIEWER,
    true,
    "security-review",
    /security-review session can't set commits true/u,
  ],
  [
    "author",
    AUTHOR,
    false,
    "hardening",
    /author stage runs no hardening session/u,
  ],
  [
    "implement",
    IMPLEMENTOR,
    true,
    "integration",
    /implement stage runs no integration session/u,
  ],
];

/** @param {string} agent @param {boolean} commits @param {Phase | undefined} phase */
function specOf(agent, commits, phase) {
  if (phase === undefined) {
    return { agent, commits };
  }
  return { agent, commits, phase };
}

test("each stage runs only its sessions: the reviewer hardens, committing, in review, and integrates, committing, then reviews security, only reading, in merge", () => {
  for (const [stage, agent, commits, phase] of ALLOWED_SESSIONS) {
    const refusal = sessionRefusalOf(stage, specOf(agent, commits, phase));
    assert.equal(refusal, null, `${stage} ${phase}`);
  }
  const listed = Object.entries(STAGE_AGENTS).flatMap(([stage, entry]) =>
    entry.sessions.map(({ phase, commits }) => [stage, phase, commits]),
  );
  assert.deepEqual(
    listed,
    ALLOWED_SESSIONS.map(([stage, , commits, phase]) => [
      stage,
      phase ?? null,
      commits,
    ]),
  );
});

test("a session with another authority or phase than its stage lists is refused, and so is a reviewer session that names no phase", () => {
  for (const [stage, agent, commits, phase, pattern] of REFUSED_SESSIONS) {
    const refusal = sessionRefusalOf(stage, specOf(agent, commits, phase));
    assert.match(refusal ?? "", pattern, `${stage} ${phase} ${commits}`);
  }
});

test("a stage refuses any other agent's session, whatever its authority", () => {
  /** @type {[Stage, string][]} */
  const others = [
    ["author", REVIEWER],
    ["implement", REVIEWER],
    ["review", IMPLEMENTOR],
    ["merge", IMPLEMENTOR],
    ["merge", AUTHOR],
    ["review", "issue-pipeline-ops"],
  ];
  for (const [stage, agent] of others) {
    for (const commits of [true, false]) {
      const refusal = sessionRefusalOf(stage, { agent, commits });
      assert.ok(refusal?.includes(`can't run ${agent}`), `${stage} ${agent}`);
    }
  }
});
