// @ts-check
// The usage log's records (#302): a launch's tally from its RPC records, the
// session record built from it, the serializer that admits only numbers,
// booleans, times and fixed names, records written before the session key,
// job start, 1h cache writes and cost were or by the installed version (its
// roles, stages, handoff and context-stop endings, context limits and issue
// tokens), and the usage comment's body. Context steering and stops left
// with session budgets, so the tally no longer counts them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolEnd, turns } from "./fake-rpc-pi.mjs";
import "./isolated-root-test-kit.mjs";
import {
  CONTEXT,
  jobRecord,
  LAUNCH,
  sessionEntry,
  sessionRecord,
} from "./usage-fixtures.mjs";

const { appendedBody, usageBody, usageLines } = await import(
  "../src/job/usage-comment.ts"
);
const { parseUsageLine, serializeUsage, usageRecord } = await import(
  "../src/job/usage-log.ts"
);
const { usageTally } = await import("../src/job/usage-tally.ts");

const LIMIT = 65_536;
const SEED = 302;
const ROUNDS = 200;
const ISSUE = 7;
const MARK = `<!-- issue-pipeline:${ISSUE}:usage -->`;
const FIRST_LINE = serializeUsage(sessionRecord());
const SECOND_LINE = serializeUsage(sessionRecord({ attempt: 2 }));

// Three turns' contexts: the first, the peak, and the last.
const FIRST = 40_000;
const PEAK = 160_000;
const LAST = 90_000;
const SHORT = 300;
const LONG = 500;
const ERROR = 4000;
const SECONDS = 3;
// The installed version's context limits and issue tokens on old records.
const LEGACY_CONTEXT = {
  first: 1200,
  peak: 5300,
  atFinish: 5000,
  soft: 150_000,
  hard: 175_000,
  steered: false,
};
const ISSUE_TOKENS = 2640;

test("first, peak and atFinish come from the first, highest and last turns", () => {
  const tally = usageTally();
  const contexts = [FIRST, PEAK, LAST];
  for (const record of turns(contexts)) {
    tally.record(record);
  }
  const usage = tally.usage(SECONDS);
  assert.deepEqual(
    [usage.turns, usage.first, usage.peak, usage.atFinish, usage.seconds],
    [contexts.length, FIRST, PEAK, LAST, SECONDS],
  );
});

test("a launch with no turns tallies zero contexts and no tools", () => {
  const usage = usageTally().usage(SECONDS);
  assert.deepEqual(
    [usage.turns, usage.first, usage.peak, usage.atFinish],
    [0, 0, 0, 0],
  );
  assert.deepEqual(usage.tools, {});
  assert.equal(usage.largest, null);
});

test("tool output is counted per tool from tool_execution_end", () => {
  const tally = usageTally();
  tally.record(toolEnd(false, "read", "x".repeat(SHORT)));
  tally.record(toolEnd(false, "read", "y".repeat(LONG)));
  tally.record(toolEnd(true, "bash", "z".repeat(ERROR)));
  const usage = tally.usage(1);
  assert.deepEqual(usage.tools, {
    read: { calls: [SHORT, LONG].length, outputChars: SHORT + LONG },
    bash: { calls: 1, outputChars: ERROR },
  });
  assert.deepEqual(usage.largest, { tool: "bash", chars: ERROR });
});

test("a session record carries the entry's facts and the job's identity", () => {
  const line = serializeUsage(usageRecord(sessionEntry(), CONTEXT));
  assert.deepEqual(parseUsageLine(line), sessionRecord());
});

test("a session record keeps a model id with its provider prefix", () => {
  const model = "anthropic/claude-opus-5-5";
  const entry = sessionEntry({ model });
  const line = serializeUsage(usageRecord(entry, CONTEXT));
  assert.deepEqual(parseUsageLine(line), sessionRecord({ model }));
  for (const bad of ["a/b/c", "/abs", "a/", "a b/c"]) {
    assert.throws(() => serializeUsage(sessionRecord({ model: bad })), bad);
  }
});

test("a record from before the session key, job start, 1h cache writes and cost still parses", () => {
  const { cacheWrite1h: _1h, cost: _cost, ...tokens } = LAUNCH.tokens;
  const {
    key: _key,
    jobStartedAt: _start,
    ...older
  } = sessionRecord({
    tokens,
  });
  const line = JSON.stringify(older);
  assert.deepEqual(parseUsageLine(line), older);
});

test("a record the installed version wrote, with its roles, stages, endings and limits, still parses", () => {
  const session = sessionRecord({
    role: "spec-writer",
    stage: "spec",
    ended: "context-stop",
    context: { ...LEGACY_CONTEXT, window: null },
  });
  assert.deepEqual(parseUsageLine(JSON.stringify(session)), session);
  const job = jobRecord({
    role: "triage",
    stages: ["triage", "spec"],
    issueTokens: ISSUE_TOKENS,
  });
  assert.deepEqual(parseUsageLine(JSON.stringify(job)), job);
});

test("a reply's outcome or verdict name is recorded, and free text as null", () => {
  /** @type {[unknown, string | null][]} */
  const replies = [
    [{ outcome: "done" }, "done"],
    [{ verdict: "approve" }, "approve"],
    [{ outcome: "a summary of the work" }, null],
    [{ status: "done" }, null],
    [null, null],
  ];
  for (const [reply, recorded] of replies) {
    const entry = sessionEntry({ reply });
    const record = parseUsageLine(serializeUsage(usageRecord(entry, CONTEXT)));
    assert.equal(record?.kind === "session" && record.reply, recorded);
  }
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
      reply: { outcome: text, verdict: text, summary: text },
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
    body.startsWith(
      "Issue pipeline usage records (hidden; described in the issue pipeline's docs/reference/)\n",
    ),
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
