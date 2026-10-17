// @ts-check
// A session's reply check (src/job/reply-checks.ts): the check a session
// effect names, run on the reply with the effect's payload and bounded to
// REPLY_CHECK_ROUNDS findings; the job's control answering it over the
// control socket for the session's launch key (src/job/control.ts); and the
// structured_output tool (src/job/structured-output.ts) failing with what
// the job finds, so the session fixes it before it ends, and saving the
// reply when the job finds nothing or can't be asked.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { openControl } from "../src/job/control.ts";
import { requestReplyCheck } from "../src/job/control-protocol.ts";
import { COMMIT_SCOPE_ENV, commitEnvOf } from "../src/job/pipeline-commit.ts";
import {
  REPLY_CHECK_ROUNDS,
  replyCheckOf,
  replyChecksOf,
} from "../src/job/reply-checks.ts";
import structuredOutput from "../src/job/structured-output.ts";
import { setEnv } from "./ops-run-test-kit.mjs";

/** @import { SessionEffect } from "../src/roles/machine.ts" */
/** @import { CheckEffect, Outcome } from "../src/job/run-step.ts" */

// A short folder, so the control socket's path fits the platform's limit.
const root = fs.mkdtempSync("/tmp/reply-checks-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

const KEY = "i7-launch-1";
const REPLY = { decision: "ready" };
const FINDINGS = "The pipeline's checks would fail this reply:\n- coverage: 2";

/** @type {SessionEffect} */
const SESSION = {
  kind: "session",
  name: "spec",
  agent: "spec-writer",
  model: "m",
  schema: {},
  task: "t",
  tokenBudget: 1,
  budgetRole: "spec",
  attempt: 1,
};
const CHECKED = {
  ...SESSION,
  replyCheck: { check: "session-reply", payload: { number: 7 } },
};

// A role check that answers `outcome`, and the effects it was given.
/** @param {Outcome} outcome */
function roleCheck(outcome) {
  /** @type {CheckEffect[]} */
  const calls = [];
  /** @param {CheckEffect} effect @returns {Promise<Outcome>} */
  function check(effect) {
    calls.push(effect);
    return Promise.resolve(outcome);
  }
  return { calls, check };
}

// What the reply check CHECKED names, over `check`, finds in each of
// `rounds` replies in turn, asked through the live reply checks.
/** @param {(effect: CheckEffect) => Promise<Outcome>} check @param {number} [rounds] @returns {Promise<(string | null)[]>} */
async function foundBy(check, rounds = 1) {
  const replyCheck = replyCheckOf(check, CHECKED);
  if (replyCheck === undefined) {
    throw new Error("the session effect names a reply check");
  }
  const checks = replyChecksOf();
  checks.add(KEY, replyCheck);
  /** @type {Promise<(string | null)[]>} */
  const none = Promise.resolve([]);
  // Each round counts the one before it, so they run in turn.
  return await Array.from({ length: rounds }).reduce(
    async (/** @type {Promise<(string | null)[]>} */ before) => {
      const found = await before;
      const { problems } = await checks.answer(KEY, REPLY);
      return [...found, problems];
    },
    none,
  );
}

/** @type {Outcome} */
const FOUND = { ok: true, name: "bad", reply: FINDINGS };

test("a session effect that names no reply check gets none", () => {
  assert.equal(replyCheckOf(roleCheck(FOUND).check, SESSION), undefined);
});

test("a reply check runs the named check with the reply in its payload and gives a bad answer's findings", async () => {
  const { calls, check } = roleCheck(FOUND);
  assert.deepEqual(await foundBy(check), [FINDINGS]);
  assert.deepEqual(calls, [
    {
      kind: "check",
      check: "session-reply",
      payload: { number: 7, reply: REPLY },
    },
  ]);
});

test("a reply check passes an ok answer and a failed check", async () => {
  /** @type {Outcome[]} */
  const outcomes = [
    { ok: true, name: "ok", reply: null },
    { ok: false, error: "git failed" },
  ];
  const found = await Promise.all(
    outcomes.map((outcome) => foundBy(roleCheck(outcome).check)),
  );
  assert.deepEqual(found, [[null], [null]]);
});

test("a reply check passes every reply after its last round of findings", async () => {
  const { calls, check } = roleCheck(FOUND);
  const found = await foundBy(check, REPLY_CHECK_ROUNDS + 1);
  const rounds = Array.from({ length: REPLY_CHECK_ROUNDS }, () => FINDINGS);
  assert.deepEqual(found, [...rounds, null]);
  assert.equal(calls.length, REPLY_CHECK_ROUNDS);
});

test("the live reply checks answer by key until released, and a check that throws passes", async () => {
  const checks = replyChecksOf();
  const release = checks.add(KEY, () => Promise.resolve(FINDINGS));
  checks.add("other", () => Promise.reject(new Error("boom")));
  assert.deepEqual(await checks.answer(KEY, REPLY), { problems: FINDINGS });
  assert.deepEqual(await checks.answer("other", REPLY), { problems: null });
  assert.deepEqual(await checks.answer("none", REPLY), { problems: null });
  release();
  assert.deepEqual(await checks.answer(KEY, REPLY), { problems: null });
});

// The job's control in a folder of its own, answering no push.
async function control() {
  const runDir = fs.mkdtempSync(path.join(root, "run-"));
  return await openControl(runDir, () => ({
    pushed: "none",
    pushError: null,
  }));
}

test("the job's control answers a session's reply check over its socket", async () => {
  const job = await control();
  try {
    /** @type {unknown[]} */
    const seen = [];
    const release = job.checkReplies(KEY, (reply) => {
      seen.push(reply);
      return Promise.resolve(FINDINGS);
    });
    assert.equal(await requestReplyCheck(job.socket, KEY, REPLY), FINDINGS);
    assert.deepEqual(seen, [REPLY]);
    assert.equal(await requestReplyCheck(job.socket, "other", REPLY), null);
    release();
    assert.equal(await requestReplyCheck(job.socket, KEY, REPLY), null);
  } finally {
    job.close();
  }
});

test("a reply check of a job older than the request, which answers it as malformed, passes", async () => {
  const socket = path.join(root, "old.sock");
  const server = net.createServer((connection) => {
    connection.end(`${JSON.stringify({ ok: false, error: "bad type" })}\n`);
  });
  await new Promise((resolve) => server.listen(socket, () => resolve(null)));
  try {
    assert.equal(await requestReplyCheck(socket, KEY, REPLY), null);
  } finally {
    server.close();
  }
});

test("a reply check of a job that can't be reached passes", async () => {
  const socket = path.join(root, "gone.sock");
  assert.equal(await requestReplyCheck(socket, KEY, REPLY), null);
});

// The structured_output tool, registered on a fake pi with an empty schema.
function outputTool() {
  const dir = fs.mkdtempSync(path.join(root, "schema-"));
  const file = path.join(dir, "schema.json");
  fs.writeFileSync(file, JSON.stringify({ type: "object" }));
  /** @type {Parameters<Parameters<typeof structuredOutput>[0]["registerTool"]>[0][]} */
  const registered = [];
  /** @type {(() => void)[]} */
  const handlers = [];
  structuredOutput({
    registerFlag: () => undefined,
    getFlag: () => file,
    registerTool: (added) => registered.push(added),
    on: (_event, handler) => handlers.push(handler),
  });
  for (const handler of handlers) {
    handler();
  }
  const [tool] = registered;
  if (tool === undefined) {
    throw new Error("the extension registers the output tool");
  }
  return tool;
}

// Sets the session's commit scope to `socket` and launch KEY.
/** @param {string} socket */
function scopeOn(socket) {
  const scope = {
    socket,
    key: KEY,
    root,
    repo: { dir: "repo", access: /** @type {const} */ ("write") },
    docs: null,
    allowed: ["**"],
  };
  const { [COMMIT_SCOPE_ENV]: env = "" } = commitEnvOf(scope);
  setEnv(COMMIT_SCOPE_ENV, env);
}

test("structured_output fails with the job's findings, and saves the reply once the job finds none", async () => {
  const job = await control();
  try {
    scopeOn(job.socket);
    /** @type {(string | null)[]} */
    const answers = [FINDINGS, null];
    job.checkReplies(KEY, () => Promise.resolve(answers.shift() ?? null));
    const tool = outputTool();
    await assert.rejects(tool.execute("c1", REPLY), { message: FINDINGS });
    const saved = await tool.execute("c2", REPLY);
    assert.deepEqual(saved.details, REPLY);
    assert.equal(saved.terminate, true);
  } finally {
    job.close();
  }
});

test("structured_output saves the reply when the session has no commit scope or no job answers", async () => {
  const tool = outputTool();
  Reflect.deleteProperty(process.env, COMMIT_SCOPE_ENV);
  assert.equal((await tool.execute("c1", REPLY)).terminate, true);
  scopeOn(path.join(root, "gone.sock"));
  assert.equal((await tool.execute("c2", REPLY)).terminate, true);
});
