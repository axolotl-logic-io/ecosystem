// @ts-check
// A writer's wrap-up at the context limits (wrap-up-at-175k, Axlog,
// 2026-10-17): past `soft` its one steer tells it to finish the edit it is
// in, commit it building and write the handoff as the next round's summary;
// stopped past `hard`, its uncommitted work gets a WIP commit
// (kill-saves-writer-work) where that is safe, whether or not it wrote a
// handoff, and the job writes the handoff when it wrote none. The job's save
// itself is tested in job-stop-handoff.test.mjs. Each async test has a
// timeout so a session the job never stops fails the test instead of hanging
// at the fake pi's "wait".
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { turns } from "./fake-rpc-pi.mjs";
import {
  logOf,
  piCommands,
  repliesAt,
  setScript,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";
import { ISSUE, sweepReply } from "./workflow-stages-fixtures.mjs";

const SOFT = 1000;
const HARD = 2000;
const LIMITS = { contextLimits: { soft: SOFT, hard: HARD } };
const PAST_SOFT = 1200;
const PAST_HARD = 2100;
const HANG_GUARD = { timeout: 60_000 };
const BRANCH = "agent/issue-7";
const SHORT_SHA = 7;
const LAST_WORDS =
  "Halfway through src/a.ts: the parser is done, its tests are not.";
const OWN = "## Done\nThe parser; its tests are left.\n";
// What the wiki's Running-the-Issue-Pipeline page (Context limits) promises
// the steer at soft tells a writer: wrap up the edit in hand, commit it, and
// write the handoff as the next round's summary of these parts.
const PROMISED_WRAP_UP = [
  "finish the edit you are in the middle of",
  "commit it",
  "summary for the next round",
  "what is done",
  "what is left",
  "decisions",
  "traps and dead ends",
  "branch state",
  "last commit",
  "checks pass",
  "`handoff`",
];
// Implement with no continuations and an exit push the fake ops makes for
// real, so the issue stops at the first handoff and the WIP commit reaches
// the origin.
const IMPLEMENT_ONCE = {
  ...repliesAt("implement"),
  sweep: sweepReply({ items: [ISSUE], config: { maxContinuations: 0 } }),
  "exit-push": { ok: true, git: true },
};
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

/** @param {string} dir @param {readonly string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...IDENTITY, ...args], {
    encoding: "utf8",
  }).trim();
}

/** @param {number} context @param {string} text @returns {object} a turn with text */
function turnSaying(context, text) {
  const turn = /** @type {{ message: object }} */ (turns([context])[0]);
  return {
    ...turn,
    message: { ...turn.message, content: [{ type: "text", text }] },
  };
}

/** @param {import("./job-test-kit.mjs").Place} place @returns {string} */
function handoffOf(place) {
  return path.join(place.runDir, "handoff.md");
}

test(
  "a writer past soft is steered to finish its edit, commit it and write the handoff as the next round's summary",
  HANG_GUARD,
  async () => {
    const events = [
      ...turns([PAST_SOFT]),
      "wait",
      ...turns([PAST_HARD]),
      "wait",
    ];
    const place = setUp(IMPLEMENT_ONCE, { events }, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const steers = piCommands(place).filter(({ type }) => type === "steer");
    assert.equal(steers.length, 1);
    const [{ message }] = steers;
    for (const part of [...PROMISED_WRAP_UP, handoffOf(place)]) {
      assert.ok(message.includes(part), `${part} in: ${message}`);
    }
    assert.ok(message.includes(String(HARD)), message);
  },
);

test(
  "a writer stopped at hard with no handoff gets one from the job, and its uncommitted work a WIP commit that reaches the branch",
  HANG_GUARD,
  async () => {
    const events = [turnSaying(PAST_HARD, LAST_WORDS), "wait"];
    const script = { events, commit: "repo/a.txt", untracked: "repo/left.txt" };
    const place = setUp(IMPLEMENT_ONCE, script, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const handoff = fs.readFileSync(handoffOf(place), "utf8");
    assert.ok(
      handoff.startsWith(
        "# Handoff: the session was stopped before it wrote its summary",
      ),
      handoff,
    );
    assert.ok(handoff.includes(`at ${PAST_HARD} tokens of context`), handoff);
    // The session's commit, its uncommitted file and its last words.
    const [committed = ""] = logOf(place, "pi.log")
      .filter((line) => "committed" in line)
      .map(({ committed: sha }) => String(sha));
    assert.ok(handoff.includes(committed.slice(0, SHORT_SHA)), handoff);
    assert.ok(handoff.includes("?? left.txt"), handoff);
    assert.ok(handoff.includes(LAST_WORDS), handoff);
    // The WIP commit holds the uncommitted file, on top of the session's,
    // and the handoff names it.
    const subjects = git(place.origin, ["log", "--format=%s", BRANCH]);
    assert.ok(subjects.startsWith("WIP:"), subjects);
    const show = ["show", "--name-only", "--format=", BRANCH];
    assert.equal(git(place.origin, show), "left.txt");
    const wip = git(place.origin, ["rev-parse", BRANCH]);
    assert.ok(handoff.includes(wip.slice(0, SHORT_SHA)), handoff);
    assert.deepEqual(statusOf(place).lostChanges, []);
  },
);

test(
  "a writer stopped at hard with its own handoff still gets its uncommitted work committed as WIP",
  HANG_GUARD,
  async () => {
    const events = [turnSaying(PAST_HARD, LAST_WORDS), "wait"];
    const place = setUp(IMPLEMENT_ONCE, { events }, LIMITS);
    const handoff = { file: handoffOf(place), text: OWN };
    setScript(place, { events, untracked: "repo/left.txt", handoff });
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const subjects = git(place.origin, ["log", "--format=%s", BRANCH]);
    assert.ok(subjects.startsWith("WIP:"), subjects);
    const show = ["show", "--name-only", "--format=", BRANCH];
    assert.equal(git(place.origin, show), "left.txt");
    assert.deepEqual(statusOf(place).lostChanges, []);
    const text = fs.readFileSync(handoffOf(place), "utf8");
    assert.ok(text.startsWith(OWN), text);
    const wip = git(place.origin, ["rev-parse", BRANCH]);
    assert.ok(text.includes(wip.slice(0, SHORT_SHA)), text);
  },
);
