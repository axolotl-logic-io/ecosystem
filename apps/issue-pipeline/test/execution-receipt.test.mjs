// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { executionFixture } from "./execution-runtime-test-kit.mjs";
import { fakeGh } from "./ops-cli-test-kit.mjs";

const { parseIssueState } = await import("../src/saved-state.ts");
const { newIssueState } = await import("../src/state.ts");
const RECEIPTS = 410;
const HISTORY = 411;
const PROVENANCE = 412;
const HELD = /reconcil|execution|authority|assigned|binding|provenance/u;
const STATE_MARK = "agent-pipeline:state";

/** @param {ReturnType<typeof import("./execution-runtime-test-kit.mjs").executionFixture>} fixture @param {unknown} raw */
function replaceState(fixture, raw) {
  fixture.update((transport) => {
    const comment = transport.comments.find((row) =>
      row.body.includes(STATE_MARK),
    );
    if (comment === undefined) {
      throw new Error("fixture has no saved state");
    }
    comment.body = `<!-- agent-pipeline:state\n${JSON.stringify(raw)}\n-->`;
  });
}

test("strict receipt matrix refuses missing, malformed and incompatible saved authority without mutation", () => {
  const fixture = executionFixture(RECEIPTS);
  const state = fixture.claim();
  const baseline = fixture.transport();
  const writes = fixture.writes();
  const cases = [
    { execution: undefined },
    { execution: null },
    { execution: {} },
    { execution: { ...state.execution, protocol: 2 } },
    { execution: { ...state.execution, request: 0 } },
    { execution: { ...state.execution, request: "1001" } },
    { execution: { ...state.execution, request: 9999 } },
    { execution: { ...state.execution, instance: "stable" } },
    { execution: { ...state.execution, instance: crypto.randomUUID() } },
    { execution: { ...state.execution, lane: "stable" } },
    { version: 1 },
    { number: HISTORY },
    { branch: "another-branch" },
    { mergeAttempt: {} },
    { security: {} },
  ];
  for (const change of cases) {
    fakeGh.transport(baseline);
    replaceState(fixture, { ...state, ...change });
    assert.throws(() => fixture.read(), HELD, JSON.stringify(change));
    assert.throws(() => fixture.claim(), HELD, JSON.stringify(change));
  }
  assert.deepEqual(fixture.writes(), writes);
  // Compatibility reads preserve old receipt-less state, but cannot promote it
  // to authenticated execution. Malformed receipts are never silently dropped.
  assert.equal(
    parseIssueState({ ...state, execution: undefined }, RECEIPTS)?.headSha,
    state.headSha,
  );
  assert.equal(parseIssueState({ ...state, execution: null }, RECEIPTS), null);
  assert.equal(parseIssueState(newIssueState(RECEIPTS), RECEIPTS)?.version, 2);
});

test("authenticated request and confirmation must bind the exact UUID, lane and configured scope", () => {
  const fixture = executionFixture(HISTORY);
  const state = fixture.claim();
  const baseline = fixture.transport();
  const identity = fixture.cfg.execution;
  assert.ok(identity);
  const replacements = [
    [identity.instance, crypto.randomUUID()],
    ['"lane":"stable"', '"lane":"other"'],
    ['"repo":"o/r"', '"repo":"other/repo"'],
    ['"base":"integration"', '"base":"main"'],
    [`"issue":${HISTORY}`, `"issue":${RECEIPTS}`],
    [`"branch":"${identity.branch}"`, '"branch":"other"'],
  ];
  const before = fixture.writes();
  for (const [from, to] of replacements) {
    assert.ok(from);
    assert.ok(to);
    fakeGh.transport(baseline);
    fixture.update((transport) => {
      for (const row of transport.comments.filter((comment) =>
        comment.body.includes('"kind":"request"'),
      )) {
        row.body = row.body.replace(from, to);
      }
    });
    assert.throws(() => fixture.read(), HELD);
  }
  for (const kind of ["request", "confirm"]) {
    fakeGh.transport(baseline);
    fixture.update((transport) => {
      transport.comments = transport.comments.filter(
        (row) => !row.body.includes(`"kind":"${kind}"`),
      );
    });
    assert.throws(() => fixture.read(), HELD);
  }
  fakeGh.transport(baseline);
  replaceState(fixture, {
    ...state,
    execution: { ...state.execution, request: baseline.comments.at(-1)?.id },
  });
  assert.throws(() => fixture.read(), HELD);
  assert.deepEqual(fixture.writes(), before);
});

test("same-read body, author and editor provenance wins over REST and forbids fallback to old authority", () => {
  const fixture = executionFixture(PROVENANCE);
  const state = fixture.claim();
  const baseline = fixture.transport();
  const before = fixture.writes();
  const changes = [
    { user: { login: "visitor" } },
    { lastEditedAt: "2026-10-21T00:00:00Z", editor: { login: "visitor" } },
    { graphAuthor: { login: "visitor" } },
    { graphBody: "<!-- agent-pipeline:state\n{}\n-->" },
    { graphBody: "marker removed by editing" },
  ];
  for (const change of changes) {
    fakeGh.transport(baseline);
    fixture.update((transport) => {
      const saved = transport.comments.find((row) =>
        row.body.includes(STATE_MARK),
      );
      assert.ok(saved);
      Object.assign(saved, change);
    });
    assert.throws(() => fixture.read(), HELD);
  }
  fakeGh.transport(baseline);
  fixture.update((transport) => {
    const saved = transport.comments.find((row) =>
      row.body.includes(STATE_MARK),
    );
    assert.ok(saved);
    saved.graphBody = saved.body;
    saved.body = "<!-- agent-pipeline:state\n{}\n-->";
  });
  assert.deepEqual(fixture.read(), state);
  assert.deepEqual(fixture.writes(), before);
});
