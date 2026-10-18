// @ts-check
// The author stage job end to end, with a fake ops.mjs and a fake RPC pi in
// a temporary pipeline root: its one session runs as issue-pipeline-author
// with no gh token, no commit scope and no pipeline_commit tool, reads the
// issue file the claim wrote, and commits nothing; its Gherkin is posted
// signed by the author and released at implement; its questions are asked
// with the inputs revision they were asked at, and that same state is
// released; a reply outside the author's schema stops the issue as an error;
// and a failed op defers only on a network error of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { pageTextOf } from "./brain-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  AFTER_READER_STAGE,
  ASKING,
  AUTHOR_SESSION,
  COMMENT_ID,
  claimWon,
  READER_STAGE,
  repliesAt,
  stateAt,
  USAGE,
} from "./job-fixtures.mjs";
import {
  flagValue,
  logOf,
  piCommands,
  piStarts,
  runJob,
  setUp,
} from "./job-test-kit.mjs";

const AUTHOR_AGENT = "issue-pipeline-author";
// A token the job holds, which no session may see.
const TOKEN = "gh-test-token";
const ISSUE_FILE = claimWon(stateAt(READER_STAGE)).issueFile;
const NO_FEATURE = { ...AUTHOR_SESSION.events[1] };
const SCHEMA_REFUSAL = /doesn't match its schema/u;
const NETWORK = "error connecting to api.github.com";
const NETWORK_DEFERRAL = /the post op failed: error connecting/u;
const NOT_A_STRING = /must be a string/u;
const AUTHOR_PROMPT = /You are the issue pipeline's Author/u;
// Where job-test-kit.mjs makes each job's pipeline root.
const TEMPORARY_ROOT = "/tmp/issue-pipeline-job-";

// Runs an author job on `replies` and `script`, the job holding a gh token;
// throws when the job fails, or when its root isn't a temporary one.
/** @param {Record<string, unknown>} replies @param {object} script */
function authorJob(replies, script) {
  const place = setUp(replies, script);
  if (!place.root.startsWith(TEMPORARY_ROOT)) {
    throw new Error(`the job's root ${place.root} isn't temporary`);
  }
  const r = runJob(
    place,
    ["--stage", READER_STAGE, "--lane", "L"],
    Object.fromEntries([["GH_TOKEN", TOKEN]]),
  );
  if (r.status !== 0) {
    throw new Error(`the job failed: ${r.stderr}`);
  }
  return { place, line: JSON.parse(r.stdout) };
}

/** @param {import("./job-test-kit.mjs").Place} place @param {string} op @returns {any[]} */
function requests(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

test("the author's one session runs as its agent with no token, no commit tool and the claim's issue file", () => {
  const { place, line } = authorJob(repliesAt(READER_STAGE), AUTHOR_SESSION);
  assert.deepEqual(line, { issue: 7, stage: READER_STAGE, end: "next" });
  const starts = piStarts(place);
  assert.equal(starts.length, 1);
  const [{ argv, env, ghToken, commitScope }] = starts;
  assert.equal(flagValue(argv, "--model"), "openai/gpt-6.1-sol");
  assert.equal(argv.includes("--no-extensions"), false);
  assert.equal(ghToken, null);
  assert.equal(env.includes("GH_TOKEN"), false);
  assert.equal(commitScope, null);
  assert.equal(flagValue(argv, "--tools").includes("pipeline_commit"), false);
  assert.equal(
    argv.some((/** @type {string} */ arg) =>
      arg.endsWith("pipeline-commit.mjs"),
    ),
    false,
  );
  assert.match(flagValue(argv, "--system-prompt"), AUTHOR_PROMPT);
  assert.equal(
    flagValue(argv, "--append-system-prompt"),
    pageTextOf("Pipeline-Prompt-Author.md"),
  );
  const [prompt] = piCommands(place).filter(({ type }) => type === "prompt");
  assert.ok(prompt.message.includes(ISSUE_FILE), prompt.message);
  // A reader commits and pushes nothing.
  assert.deepEqual(requests(place, "exit-push"), []);
  assert.deepEqual(requests(place, "push"), []);
  const branch = spawnSync(
    "git",
    ["-C", place.origin, "rev-parse", "--verify", "--quiet", "agent/issue-7"],
    { encoding: "utf8" },
  );
  assert.notEqual(branch.status, 0);
});

test("the author's Gherkin is posted signed by the author and the issue released at implement", () => {
  const { place } = authorJob(repliesAt(READER_STAGE), AUTHOR_SESSION);
  const [post] = requests(place, "post");
  const [comment] = post.comments;
  assert.deepEqual(
    { number: comment.number, key: comment.key, by: comment.by },
    {
      number: 7,
      key: "gherkin",
      by: { role: "author", agent: AUTHOR_AGENT, model: null, run: null },
    },
  );
  const [release] = requests(place, "release");
  assert.equal(release.lane, "L");
  assert.equal(typeof release.sweepId, "string");
  assert.equal(release.state.stage, AFTER_READER_STAGE);
  assert.equal(release.state.gherkin.commentId, COMMENT_ID);
  assert.equal(release.state.asked, null);
  // One usage line for the session and one for the job.
  assert.equal(requests(place, "usage").length, 2);
});

test("an author's questions are asked with the inputs revision, and that state is released", () => {
  const asking = { events: [messageEnd(USAGE), outputEnd(ASKING)] };
  const { place, line } = authorJob(repliesAt(READER_STAGE), asking);
  assert.equal(line.end, "ask");
  const [ask] = requests(place, "ask");
  assert.deepEqual(ask.questions, ASKING.questions);
  assert.deepEqual(ask.by, { role: "author", agent: AUTHOR_AGENT });
  assert.equal(ask.state.stage, READER_STAGE);
  assert.equal(typeof ask.state.asked.inputs, "string");
  assert.ok(ask.state.asked.inputs.length > 0);
  const [release] = requests(place, "release");
  assert.deepEqual(release.state, ask.state);
  assert.deepEqual(requests(place, "post"), []);
});

test("an author reply outside its schema stops the issue as an error and posts nothing", () => {
  const bad = {
    ...NO_FEATURE,
    result: { content: [], details: { outcome: "gherkin", gherkin: "no" } },
  };
  const { place, line } = authorJob(repliesAt(READER_STAGE), {
    events: [messageEnd(USAGE), bad],
  });
  assert.equal(line.end, "stop");
  const [stop] = requests(place, "stop");
  assert.equal(stop.code, "error");
  assert.match(stop.reason, SCHEMA_REFUSAL);
  assert.deepEqual(requests(place, "post"), []);
  assert.deepEqual(requests(place, "release"), []);
});

test("a post that fails on the network defers, releasing the claimed state", () => {
  const replies = {
    ...repliesAt(READER_STAGE),
    post: { ok: false, error: NETWORK },
  };
  const { place, line } = authorJob(replies, AUTHOR_SESSION);
  assert.equal(line.end, "deferred");
  assert.match(line.reason, NETWORK_DEFERRAL);
  const [release] = requests(place, "release");
  assert.equal(release.state.stage, READER_STAGE);
  assert.deepEqual(requests(place, "stop"), []);
});

test("a post that fails otherwise stops the issue as an error", () => {
  const replies = {
    ...repliesAt(READER_STAGE),
    post: { ok: false, error: "post: comments[0].body must be a string" },
  };
  const { place, line } = authorJob(replies, AUTHOR_SESSION);
  assert.equal(line.end, "stop");
  const [stop] = requests(place, "stop");
  assert.equal(stop.code, "error");
  assert.match(stop.reason, NOT_A_STRING);
  assert.deepEqual(requests(place, "release"), []);
});
