// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { merging, REBASED, WIKI_PASS } from "./merge-role-test-kit.mjs";
import {
  opNames,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  current,
  HEAD,
  MOVED,
  mergeRole,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const RECOVERED = { ...REVISION, wiki: MOVED };
const CHECKED = { ...RECOVERED, code: REBASED };

test("a recovered wiki must be pinned, verified and wiki-checked before earning integration linked to original hardening", async () => {
  const { ctx, calls } = merging({
    state: { verifiedSha: HEAD },
    ops: {
      "pin-wiki": [{ changed: true }],
      "current-revision": [
        { ...current(RECOVERED), recoveredWiki: true },
        current(CHECKED),
      ],
      verify: [{ pass: true, headSha: REBASED, checks: [] }],
      "wiki-check": [WIKI_PASS],
      push: [{ headSha: REBASED, codeChanged: true, wikiAhead: 1 }],
    },
    sessions: [],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.deepEqual(state.hardened, REVISION);
  assert.deepEqual(state.integration, {
    reviewed: REVISION,
    revision: CHECKED,
  });
  assert.equal(state.verifiedSha, REBASED);
  assert.equal(state.security, null);
  assert.deepEqual(opNames(calls), [
    "current-revision",
    "pin-wiki",
    "verify",
    "wiki-check",
    "push",
    "current-revision",
  ]);
  assert.equal(sessionsOf(calls).length, 0);
});

test("failed exact recovered checks cannot reuse interrupted verification or grant publication", async () => {
  const { ctx, calls } = merging({
    state: { verifiedSha: HEAD },
    ops: {
      "pin-wiki": [{ changed: true }],
      "current-revision": [{ ...current(RECOVERED), recoveredWiki: true }],
      verify: [
        {
          pass: false,
          headSha: HEAD,
          checks: [{ id: "test", pass: false, detail: "failed" }],
        },
      ],
      "wiki-check": [WIKI_PASS],
    },
    sessions: [],
  });
  const stoppedCtx = { ...ctx, cfg: { ...ctx.cfg, maxCiFixes: 0 } };
  const end = await mergeRole(stoppedCtx);
  assert.equal(end.kind, "stop");
  assert.equal(end.state.integration, null);
  assert.equal(end.state.verifiedSha, null);
  assert.equal(end.state.security, null);
  assert.deepEqual(opNames(calls), [
    "current-revision",
    "pin-wiki",
    "verify",
    "wiki-check",
  ]);
});

for (const movement of ["code", "inputs"]) {
  test(`wiki recovery cannot waive changed ${movement} gates before integration`, async () => {
    const revision = { ...RECOVERED, [movement]: MOVED };
    const { ctx, calls } = merging({
      ops: {
        "current-revision": [{ ...current(revision), recoveredWiki: true }],
      },
      sessions: [],
    });
    const state = stateOf(await mergeRole(ctx), "next");
    let expected = "review";
    if (movement === "inputs") {
      expected = "author";
    }
    assert.equal(state.stage, expected);
    assert.equal(state.integration, null);
    assert.equal(state.security, null);
    assert.deepEqual(opNames(calls), ["current-revision"]);
    assert.equal(sessionsOf(calls).length, 0);
  });
}
