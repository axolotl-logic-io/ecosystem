// @ts-check
// An issue's four flows (#217): code only, wiki only, both or neither, and
// what each means for its PR, open or closed.
import assert from "node:assert/strict";
import { test } from "node:test";

const { flowsOf, prFlowAction } = await import("../src/workflow/flows.ts");
const { stopFor } = await import("../src/stops.ts");

const CODE = { code: true, wiki: false };
const WIKI = { code: false, wiki: true };
const BOTH = { code: true, wiki: true };
const NEITHER = { code: false, wiki: false };
const WIKI_COMMITS = 2;

test("flowsOf reads code from codeChanged and the wiki from wikiAhead", () => {
  assert.deepEqual(flowsOf({ codeChanged: true, wikiAhead: 0 }), CODE);
  assert.deepEqual(flowsOf({ codeChanged: false, wikiAhead: 1 }), WIKI);
  assert.deepEqual(
    flowsOf({ codeChanged: true, wikiAhead: WIKI_COMMITS }),
    BOTH,
  );
  assert.deepEqual(flowsOf({ codeChanged: false, wikiAhead: 0 }), NEITHER);
});

test("a change that touches code goes on with its PR open, and reopens a closed one", () => {
  assert.equal(prFlowAction(CODE, false), "go");
  assert.equal(prFlowAction(BOTH, false), "go");
  assert.equal(prFlowAction(CODE, true), "reopen");
  assert.equal(prFlowAction(BOTH, true), "reopen");
});

test("a wiki-only change closes its open PR and leaves a closed one closed", () => {
  assert.equal(prFlowAction(WIKI, false), "close");
  assert.equal(prFlowAction(WIKI, true), "go");
});

test("a change that changed nothing stops, whatever its PR", () => {
  assert.equal(prFlowAction(NEITHER, false), "stop");
  assert.equal(prFlowAction(NEITHER, true), "stop");
});

test("the stop for a change that changed nothing is labelled agent:stopped-not-doable", () => {
  const stop = stopFor("the implementation changed nothing");
  assert.equal(stop?.label.name, "agent:stopped-not-doable");
});
