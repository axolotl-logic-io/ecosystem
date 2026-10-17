// @ts-check
// The usage log's records (#302): a launch's tally from its RPC records, the
// session record built from it, the serializer that admits only numbers,
// booleans, times and fixed names, and the usage comment's body.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendedBody,
  usageBody,
  usageLines,
} from "../src/job/usage-comment.ts";
import {
  parseUsageLine,
  serializeUsage,
  usageRecord,
} from "../src/job/usage-log.ts";
import { usageTally } from "../src/job/usage-tally.ts";
import { toolEnd, turns } from "./fake-rpc-pi.mjs";
import { LAUNCH } from "./runner-test-kit.mjs";
import { CONTEXT, sessionRecord } from "./usage-fixtures.mjs";

/** @import { SessionEntry } from "../src/job/run-usage.ts" */

const SOFT = 150_000;
const LIMIT = 65_536;
const SEED = 302;
const ROUNDS = 200;
const ISSUE = 7;
const MARK = `<!-- issue-pipeline:${ISSUE}:usage -->`;
const FIRST_LINE = serializeUsage(sessionRecord());
const SECOND_LINE = serializeUsage(sessionRecord({ attempt: 2 }));

/** @param {Partial<SessionEntry>} [over] @returns {SessionEntry} */
function sessionEntry(over = {}) {
  return {
    kind: "session",
    at: "2026-10-16T12:00:00.000Z",
    stage: "spec",
    state: "work",
    name: "work",
    agent: "toy-writer",
    model: "mock",
    attempt: 1,
    taskChars: 16,
    schema: {
      type: "object",
      properties: { status: { type: "string", enum: ["done", "handoff"] } },
    },
    ended: "reply",
    reply: { status: "done" },
    launch: LAUNCH,
    ...over,
  };
}

// Three turns' contexts: the first, the peak past SOFT, and the last.
const FIRST = 40_000;
const PEAK = 160_000;
const LAST = 90_000;
// A launch's session, stopped past `hard`, then its shorter retry.
const STOPPED = 100_000;
const RETRY = 30_000;
const SHORT = 300;
const LONG = 500;
const ERROR = 4000;
const SECONDS = 3;

test("first, peak and atFinish come from the first, highest and last turns", () => {
  const tally = usageTally(SOFT);
  const contexts = [FIRST, PEAK, LAST];
  for (const record of turns(contexts)) {
    tally.record("s1", record);
  }
  const usage = tally.usage(SECONDS);
  assert.deepEqual(
    [usage.turns, usage.first, usage.peak, usage.atFinish, usage.steered],
    [contexts.length, FIRST, PEAK, LAST, true],
  );
  assert.deepEqual([usage.stopped, usage.seconds], [false, SECONDS]);
});

test("a retry's turns count with the launch's, and a stop of the last session shows", () => {
  const tally = usageTally(SOFT);
  const [stopped, retry] = turns([STOPPED, RETRY]);
  tally.record("s1", stopped);
  tally.contextStopped("s1");
  tally.record("s1-retry", retry);
  assert.equal(tally.usage(1).stopped, false);
  tally.contextStopped("s1-retry");
  const usage = tally.usage(1);
  assert.deepEqual(
    [usage.first, usage.peak, usage.atFinish, usage.stopped, usage.steered],
    [STOPPED, STOPPED, RETRY, true, false],
  );
  assert.equal(usage.turns, [stopped, retry].length);
});

test("tool output is counted per tool from tool_execution_end", () => {
  const tally = usageTally(SOFT);
  tally.record("s1", toolEnd(false, "read", "x".repeat(SHORT)));
  tally.record("s1", toolEnd(false, "read", "y".repeat(LONG)));
  tally.record("s1", toolEnd(true, "bash", "z".repeat(ERROR)));
  const usage = tally.usage(1);
  assert.deepEqual(usage.tools, {
    read: { calls: [SHORT, LONG].length, outputChars: SHORT + LONG },
    bash: { calls: 1, outputChars: ERROR },
  });
  assert.deepEqual(usage.largest, { tool: "bash", chars: ERROR });
});

test("a session record carries the entry's facts and the job's identity", () => {
  const line = serializeUsage(usageRecord(sessionEntry(), CONTEXT));
  assert.deepEqual(parseUsageLine(line), sessionRecord({ reply: "done" }));
});

test("a reply value the schema's enum doesn't list is recorded as null", () => {
  const entry = sessionEntry({ reply: { status: "a summary of the work" } });
  const record = parseUsageLine(serializeUsage(usageRecord(entry, CONTEXT)));
  assert.equal(record?.kind === "session" && record.reply, null);
});

test("a tool whose name isn't a plain name is counted under other", () => {
  const tools = { "my tool/x": { calls: 1, outputChars: 9 } };
  const launch = { ...LAUNCH, tools, largest: { tool: "my tool/x", chars: 9 } };
  const line = serializeUsage(usageRecord(sessionEntry({ launch }), CONTEXT));
  const record = parseUsageLine(line);
  assert.deepEqual(record?.kind === "session" && record.tools, {
    other: { calls: 1, outputChars: 9 },
  });
});

test("the serializer refuses free text, an absolute path, an unknown key and -->", () => {
  const refused = [
    sessionRecord({ state: "a sentence with spaces" }),
    sessionRecord({ model: "/Users/someone/model" }),
    sessionRecord({ task: { chars: 1, files: { "/etc/hosts": 3 } } }),
    sessionRecord({ task: { chars: 1, files: { "../up.md": 3 } } }),
    sessionRecord({ agent: "x-->" }),
    sessionRecord({ summary: "done" }),
    sessionRecord({ job: "not-a-uuid" }),
  ];
  for (const record of refused) {
    assert.throws(() => serializeUsage(record));
  }
  const files = { "src/a.ts": 120, "wiki/Home.md": 40, "spec.md": 9 };
  const line = serializeUsage(sessionRecord({ task: { chars: 1, files } }));
  assert.deepEqual(
    parseUsageLine(line),
    sessionRecord({ task: { chars: 1, files } }),
  );
});

// Park and Miller's minimal standard generator.
const MODULUS = 2_147_483_647;
const MULTIPLIER = 16_807;
const PHRASE_WORDS = 3;
const NONCE = 1e9;

/** @param {number} seed @returns {() => number} a deterministic PRNG in [0, 1) */
function minimalStandard(seed) {
  let state = seed;
  return () => {
    state = (state * MULTIPLIER) % MODULUS;
    return state / MODULUS;
  };
}

/** @param {() => number} random @returns {string} a random phrase */
function phrase(random) {
  const words = ["secret", "task", "reply", "summary", "/home/me", "pid"];
  const picked = Array.from(
    { length: PHRASE_WORDS },
    () => words[Math.floor(random() * words.length)],
  );
  return `${picked.join(" ")} ${Math.floor(random() * NONCE)}`;
}

test("no record holds the launch's task or reply text", () => {
  const random = minimalStandard(SEED);
  for (let round = 0; round < ROUNDS; round += 1) {
    const task = phrase(random);
    const text = phrase(random);
    const entry = sessionEntry({
      taskChars: task.length,
      reply: { status: text, summary: text, decision: text },
    });
    const line = serializeUsage(usageRecord(entry, CONTEXT));
    assert.ok(!line.includes(task));
    assert.ok(!line.includes(text));
  }
});

test("a usage body round-trips its lines and its mark", () => {
  const lines = [FIRST_LINE, SECOND_LINE];
  const body = usageBody(ISSUE, 1, lines);
  assert.ok(
    body.startsWith("Issue pipeline usage records (hidden; see the wiki)\n"),
  );
  assert.ok(body.includes(MARK));
  assert.deepEqual(usageLines(body), lines);
  assert.ok(
    usageBody(ISSUE, 2, lines).includes(
      `<!-- issue-pipeline:${ISSUE}:usage-2 -->`,
    ),
  );
  const appended = appendedBody(usageBody(ISSUE, 1, [FIRST_LINE]), SECOND_LINE);
  assert.equal(appended, body);
});

test("appending past 65,536 characters gives null", () => {
  const line = serializeUsage(sessionRecord());
  const count = Math.floor(LIMIT / (line.length + 1));
  let body = usageBody(
    ISSUE,
    1,
    Array.from({ length: count - 1 }, () => line),
  );
  assert.ok(body.length <= LIMIT);
  let next = appendedBody(body, line);
  while (next !== null) {
    body = next;
    next = appendedBody(body, line);
  }
  assert.ok(body.length <= LIMIT);
  assert.ok(body.length + line.length + 1 > LIMIT);
});
