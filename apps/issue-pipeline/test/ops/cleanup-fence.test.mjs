// @ts-check
// The cleanup op's fence (#170), through the real ops CLI: a closed issue
// whose work is all on GitHub still keeps its worktree, branch, teardown
// resources and lane slot while a registered consumer needs them or its
// execution is still held, and a stale cleanup makes no effect at all.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { githubComment } from "../fake-gh.mjs";
import {
  ask,
  fakeGh,
  ISSUE,
  REPO,
  replyLine,
  sh,
  stateListing,
  world,
} from "./ops-test-kit.mjs";

/** @import { World } from "./ops-test-kit.mjs" */

const CLOSED = { when: "--jq {state}", stdout: '{"state":"closed"}' };
const MERGED = { pr: 50, stage: "done" };
const BRANCH = "agent/issue-7";
const BASE = "integration";
const SHA_LENGTH = 40;
const REQUEST_ID = 900;
const UNCONFIRMED = /execution ownership lost or unconfirmed/u;
const REMOVED = /"outcome":"removed"/u;

/**
 * A world whose closed issue's work is on GitHub, with lane slots on, a
 * teardown that leaves a marker, and issue #7's slot owned by its worktree
 * and `extra`.
 * @param {{ checkouts?: string[], pendingSetup?: string[] }} extra
 */
function slotWorld(extra) {
  const w = world();
  const config = JSON.parse(fs.readFileSync(w.config, "utf8"));
  const marker = path.join(w.root, "torn-down");
  const commands = { ...config.commands, teardown: `touch ${marker}` };
  fs.writeFileSync(
    w.config,
    JSON.stringify({ ...config, commands, laneSlots: 1 }),
  );
  sh(`git -C ${w.worktree} push -q origin HEAD:refs/pull/50/head`);
  const store = path.join(w.root, "runs", "o__r", "lane-slots.json");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const lease = {
    issue: ISSUE,
    slot: 1,
    checkouts: [w.worktree, ...(extra.checkouts ?? [])],
    pendingSetup: extra.pendingSetup ?? [],
  };
  fs.writeFileSync(store, JSON.stringify({ leases: [lease], prunedAt: null }));
  return { ...w, marker, store };
}

/** @param {World} w @returns {string} an independent checkout that exists */
function secondary(w) {
  const dir = path.join(w.root, "secondary");
  sh(`git init -q ${dir}`);
  return dir;
}

/** @param {ReturnType<typeof slotWorld>} w */
function leftBehind(w) {
  return {
    worktree: fs.existsSync(w.worktree),
    tornDown: fs.existsSync(w.marker),
    store: JSON.parse(fs.readFileSync(w.store, "utf8")),
  };
}

/** @param {string} why */
function kept(why) {
  const worktrees = [{ issue: ISSUE, outcome: "kept", why }];
  return replyLine({
    ok: true,
    op: "cleanup",
    posted: 0,
    commentIds: [],
    worktrees,
  });
}

// Issue #7's listing: its done state, and an execution request by lane L
// that no release or cancel ended.
function heldListing() {
  const record = {
    version: 1,
    scope: JSON.stringify([REPO, BASE, "issue", ISSUE, BRANCH]),
    operation: randomUUID(),
    kind: "request",
    identity: {
      instance: randomUUID(),
      lane: "L",
      issue: ISSUE,
      branch: BRANCH,
      repo: REPO,
      base: BASE,
    },
    token: "1".padStart(SHA_LENGTH, "0"),
  };
  const request = githubComment({
    id: REQUEST_ID,
    body: `<!-- agent-pipeline:coordination\n${JSON.stringify(record)}\n-->`,
    login: "bot",
    created: new Date().toISOString(),
  });
  const state = stateListing(ISSUE, MERGED);
  return {
    when: state.when,
    stdout: `${state.stdout}\n${JSON.stringify(request)}`,
  };
}

test("a registered secondary checkout keeps a closed issue's worktree, teardown and slot", () => {
  const w = slotWorld({});
  const other = secondary(w);
  const store = JSON.parse(fs.readFileSync(w.store, "utf8"));
  store.leases[0].checkouts.push(other);
  fs.writeFileSync(w.store, JSON.stringify(store));
  fakeGh.reply([CLOSED, stateListing(ISSUE, MERGED)]);
  const reply = ask(w, { op: "cleanup", skip: null });
  assert.equal(
    reply,
    kept(`the lane slot still has registered consumers: ${other}`),
  );
  assert.deepEqual(leftBehind(w), { worktree: true, tornDown: false, store });
});

test("a pending setup keeps a closed issue's worktree, teardown and slot, though no patch or other checkout is left", () => {
  const w = slotWorld({});
  const store = JSON.parse(fs.readFileSync(w.store, "utf8"));
  store.leases[0].pendingSetup = [w.worktree];
  fs.writeFileSync(w.store, JSON.stringify(store));
  fakeGh.reply([CLOSED, stateListing(ISSUE, MERGED)]);
  const reply = ask(w, { op: "cleanup", skip: null });
  assert.equal(
    reply,
    kept(`the lane slot still has registered consumers: ${w.worktree}`),
  );
  assert.deepEqual(leftBehind(w), { worktree: true, tornDown: false, store });
});

test("an execution request no release ended keeps a closed issue's worktree", () => {
  const w = slotWorld({});
  const before = leftBehind(w);
  fakeGh.reply([CLOSED, heldListing()]);
  const reply = ask(w, { op: "cleanup", skip: null });
  assert.equal(reply, kept("issue execution is held by lane L"));
  assert.deepEqual(leftBehind(w), before);
});

test("with no consumer and no held execution, the same closed issue is removed and its slot freed", () => {
  const w = slotWorld({});
  fakeGh.reply([CLOSED, stateListing(ISSUE, MERGED)]);
  const reply = ask(w, { op: "cleanup", skip: null });
  assert.match(reply, REMOVED);
  assert.deepEqual(leftBehind(w), {
    worktree: false,
    tornDown: true,
    store: { leases: [], prunedAt: null },
  });
});

test("a stale cleanup whose binding no longer owns its issue makes no effect", () => {
  const w = slotWorld({});
  const before = leftBehind(w);
  // No coordination record and no epoch ref: nobody owns the issue, so
  // this binding's ownership is lost.
  const noRef = {
    when: "git/ref/",
    stdout: "",
    stderr: "HTTP 404: Not Found",
    code: 1,
  };
  fakeGh.reply([stateListing(ISSUE, MERGED), noRef, noRef]);
  const execution = {
    instance: randomUUID(),
    lane: "L",
    issue: ISSUE,
    branch: BRANCH,
    repo: REPO,
    base: BASE,
  };
  const reply = ask(w, {
    op: "cleanup",
    skip: null,
    number: ISSUE,
    execution,
    checkout: { issue: ISSUE, dir: w.worktree, branch: BRANCH },
  });
  const line = JSON.parse(reply.trim().split("\n").at(-1) ?? "null");
  assert.equal(line.ok, false);
  assert.match(line.error, UNCONFIRMED);
  assert.deepEqual(leftBehind(w), before);
});
