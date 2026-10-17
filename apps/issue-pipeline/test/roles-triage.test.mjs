// @ts-check
// The triage role on the role runner (#304), with the mock session and fake
// ops: what each decision does to the issue, the stops before a session, a
// run killed anywhere and started again, and that the role's modules import
// no other role.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  killedTriage,
  PR,
  replyOf,
  TRIAGE_OPS,
  triage,
} from "./triage-role-test-kit.mjs";

/** @import { OpFake } from "./runner-test-kit.mjs" */

const MARK = "<!-- issue-pipeline:7:triage -->";
const REJECTED = "triage rejected the issue for the agent pipeline";
/** @type {readonly ("before" | "after")[]} */
const KILL_POINTS = ["before", "after"];
const SRC = path.join(import.meta.dirname, "..", "src");
const TRIAGE_DIR = path.join(SRC, "roles", "triage");
const IMPORT_FROM = /from "(?<spec>[^"]+)"/gu;
// The stage modules the role may share: plain guards and types.
const SHARED_STAGE_MODULES = ["reply-guards.ts", "types.ts"];
// The longest plan the state keeps, and a plan longer than that.
const PLAN_LIMIT = 4000;
const LONG_PLAN = 5000;
// The kept plan: its first PLAN_LIMIT characters and the clip's ellipsis.
const CLIPPED_PLAN = `${"p".repeat(PLAN_LIMIT)}…`;
const MAX_TRIAGES = 4;
const OPENED_PR = 9;
// reply, task, locate and script.
const ROLE_MODULES = 4;
const REJECT_COMMENT = /isn't one the pipeline should take on: far too big/u;
const TAKING_COMMENT = /Taking this issue\. Small\./u;
const PR_FAILED = /could not open the draft PR yet: gh down/u;

/** @param {readonly string[][]} writes @returns {string[]} the triage-keyed comments posted */
function triagePosts(writes) {
  return writes
    .filter(([cmd, sub]) => cmd === "issue" && sub === "comment")
    .map((args) => args.join(" "))
    .filter((text) => text.includes(MARK));
}

/** @param {unknown[]} seen @param {OpFake} fake @returns {OpFake} the fake, recording each payload */
function seeing(seen, fake) {
  return (store, payload) => {
    seen.push(payload);
    return fake(store, payload);
  };
}

/** @param {{ calls: { name: string }[] }} run @param {string} name */
function sent(run, name) {
  return run.calls.some((call) => call.name === name);
}

const READY = {
  reply: replyOf({ decision: "ready", reason: "Ok.", plan: "p" }),
};
const SPLIT = {
  reply: replyOf({ decision: "split", reason: "Big.", plan: "p" }),
};
const ASK = { reply: replyOf({ decision: "needs-info", questions: ["Why?"] }) };
const REJECT = { reply: replyOf({ decision: "reject", reason: "No." }) };

// Each decision's uninterrupted run, made before any test is defined, so no
// test's fake gh calls come between.
const SCENARIOS = [
  { name: "ready", setup: READY, reference: await triage(READY) },
  { name: "split", setup: SPLIT, reference: await triage(SPLIT) },
  { name: "needs-info", setup: ASK, reference: await triage(ASK) },
  { name: "reject", setup: REJECT, reference: await triage(REJECT) },
];

test("a sub-issue's split stops with triage-rejected and the reject comment", async () => {
  const reply = replyOf({ decision: "split", reason: "far too big" });
  const run = await triage({ reply, start: { depth: 1 } });
  assert.deepEqual(run.end, { kind: "stopped", code: "triage-rejected" });
  const { stage, stopReason } = run.saved;
  assert.equal(stage, "stopped");
  assert.equal(stopReason, REJECTED);
  assert.deepEqual(run.labels, ["agent:stopped-triage-rejected"]);
  const [posted, ...more] = triagePosts(run.writes);
  assert.match(String(posted), REJECT_COMMENT);
  assert.deepEqual(more, []);
});

test("a ready issue is taken, gets its draft PR, and is saved at spec", async () => {
  /** @type {unknown[]} */
  const seen = [];
  const plan = "p".repeat(LONG_PLAN);
  const run = await triage({
    reply: replyOf({ decision: "ready", reason: "Small.", plan }),
    ops: { "start-pr": seeing(seen, TRIAGE_OPS["start-pr"]) },
  });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  const { stage, plan: kept, pr, lease } = run.saved;
  assert.equal(stage, "spec");
  assert.equal(kept, CLIPPED_PLAN);
  assert.equal(pr, PR);
  assert.equal(lease, null);
  assert.deepEqual(seen, [{ number: 7, plan: CLIPPED_PLAN }]);
  assert.match(String(triagePosts(run.writes)[0]), TAKING_COMMENT);
});

test("a ready issue with a PR opens none", async () => {
  const reply = replyOf({ decision: "ready", reason: "Small." });
  const run = await triage({ reply, start: { pr: OPENED_PR } });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  assert.equal(sent(run, "start-pr"), false);
  assert.equal(run.saved.pr, OPENED_PR);
});

test("a failed draft PR is only logged, and the issue is still saved at spec", async () => {
  const run = await triage({
    reply: replyOf({ decision: "ready", reason: "Small." }),
    ops: { "start-pr": () => ({ reply: { ok: false, error: "gh down" } }) },
  });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  const log = JSON.stringify(run.saved.log);
  assert.match(log, PR_FAILED);
});

test("a large issue is saved at spec with its split suggested, and nothing opened", async () => {
  const reply = replyOf({ decision: "split", reason: "Too big.", plan: "cut" });
  const run = await triage({ reply });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  const { splitSuggested, plan } = run.saved;
  assert.equal(splitSuggested, "Too big.");
  assert.equal(plan, "cut");
  assert.equal(sent(run, "start-pr"), false);
  assert.equal(sent(run, "split"), false);
});

test("questions are asked after the release, on the state it saved", async () => {
  /** @type {unknown[]} */
  const seen = [];
  const questions = ["Which page?"];
  const run = await triage({
    reply: replyOf({ decision: "needs-info", questions }),
    ops: { ask: seeing(seen, TRIAGE_OPS.ask) },
  });
  assert.deepEqual(run.end, { kind: "released" });
  const state = { stage: "triage", lease: null, triages: 1 };
  assert.partialDeepStrictEqual(seen, [{ number: 7, questions, state }]);
  const { questionsAt } = run.saved;
  assert.equal(questionsAt, "now");
  assert.deepEqual(run.labels, ["agent:needs-info"]);
  assert.deepEqual(triagePosts(run.writes), []);
});

test("questions with none asked read as a reject", async () => {
  const run = await triage({ reply: replyOf({ decision: "needs-info" }) });
  assert.deepEqual(run.end, { kind: "stopped", code: "triage-rejected" });
  assert.equal(sent(run, "ask"), false);
});

test("a run past maxTriages stops with no session", async () => {
  const run = await triage({
    start: { triages: MAX_TRIAGES },
    cfg: { maxTriages: MAX_TRIAGES },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "triage-limit" });
  assert.equal(sent(run, "triage"), false);
  assert.deepEqual(run.labels, ["agent:stopped-triage-limit"]);
});

test("a reply that doesn't fit the schema stops triage", async () => {
  const run = await triage({ reply: { decision: "maybe" } });
  assert.deepEqual(run.end, { kind: "stopped", code: "error" });
  const { stopReason } = run.saved;
  assert.equal(stopReason, "triage failed");
});

for (const { name, setup, reference } of SCENARIOS) {
  for (let k = 1; k <= reference.calls.length; k += 1) {
    for (const when of KILL_POINTS) {
      test(`a ${name} triage killed ${when} call ${k} ends as an uninterrupted one`, async () => {
        const run = await killedTriage({ k, when }, setup);
        // A run the claim wouldn't start again has no end of its own.
        const end =
          run.end === "killed" || isDeepStrictEqual(run.end, reference.end);
        assert.ok(end, JSON.stringify(run.end));
        for (const field of ["stage", "plan", "splitSuggested"]) {
          const { [field]: value } = run.saved;
          const { [field]: expected } = reference.saved;
          assert.deepEqual(value, expected, field);
        }
        assert.deepEqual(run.labels, reference.labels);
        const posts = triagePosts(run.writes).length;
        const expected = triagePosts(reference.writes).length;
        assert.ok(expected <= 1, `${name} posts ${expected} triage comments`);
        assert.equal(posts, expected);
      });
    }
  }
}

/** @param {string} dir @returns {string[]} the .ts files under `dir` */
function sources(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.join(dir, file));
}

/** @param {string} file @returns {string} why one of its imports is another role's, or "" */
function foreignImport(file) {
  const found = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_FROM)) {
    const { spec } = match.groups ?? {};
    const target = path.resolve(path.dirname(file), spec ?? "");
    const fromSrc = path.relative(SRC, target).split(path.sep);
    const [top, sub, leaf] = fromSrc;
    const otherRole = top === "roles" && fromSrc.length > 2 && sub !== "triage";
    const stage =
      top === "workflow" &&
      sub === "stages" &&
      !SHARED_STAGE_MODULES.includes(String(leaf));
    if (otherRole || stage) {
      found.push(`${path.basename(file)} imports ${fromSrc.join("/")}`);
    }
  }
  return found.join("; ");
}

test("the triage role imports no other role's modules", () => {
  const files = sources(TRIAGE_DIR);
  assert.ok(files.length >= ROLE_MODULES);
  assert.deepEqual(files.map(foreignImport).filter(Boolean), []);
});
