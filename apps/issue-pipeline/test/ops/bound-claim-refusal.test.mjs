// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runDir, worktree } from "../ops-cli-test-kit.mjs";
import { boundFixture } from "./bound-claim-test-kit.mjs";

const { stopRecovery } = await import("../../src/stop-recovery.ts");
const { assertCheckoutReady } = await import("../../src/lane-slots.ts");
const MALFORMED = /Expected property name.*JSON/u;
const HELD = /reconcil|authority|execution|provenance|prior|no merge/u;
const ISSUE = 520;
const SETUP = 521;
const RECOVERY = 522;
const MISSING_PR = 523;
const PR = 91;
const SETUP_FAILED = /lane setup failed/u;
const NOT_READY = /lane setup is incomplete/u;
const MISSING_REPLY = /unsupported private fake gh request/u;

for (const fault of [
  "missing receipt",
  "malformed",
  "history",
  "provenance",
  "legacy",
  "single account",
]) {
  test(`real authenticated reads refuse ${fault} without changing saved work`, () => {
    const f = boundFixture(ISSUE, { extra: { legacyAccount: "old-bot" } });
    f.claim();
    f.guard().release();
    f.update((transport) => {
      const comment = transport.comments.find((item) =>
        item.body.includes("agent-pipeline:state"),
      );
      if (comment === undefined) {
        throw new Error("missing fixture state");
      }
      if (fault === "single account") {
        comment.user.login = f.cfg.devAccount;
      } else if (fault === "provenance") {
        comment.lastEditedAt = "2026-10-21T00:00:00Z";
        comment.editor = { login: "visitor" };
      } else if (fault === "malformed") {
        comment.body = "<!-- agent-pipeline:state\n{broken\n-->";
      } else if (fault === "legacy") {
        comment.user.login = "old-bot";
      } else {
        const start = comment.body.indexOf(
          "\n",
          comment.body.indexOf("<!-- agent-pipeline:state"),
        );
        const end = comment.body.lastIndexOf("\n-->");
        const state = JSON.parse(comment.body.slice(start, end));
        if (fault === "history") {
          state.execution.request += 1;
        } else {
          state.execution = undefined;
        }
        comment.body = `${comment.body.slice(0, start)}\n${JSON.stringify(state)}${comment.body.slice(end)}`;
      }
    });
    const before = f.transport();
    const writes = f.writes();
    let expected = HELD;
    if (fault === "malformed") {
      expected = MALFORMED;
    }
    assert.throws(() => f.claimBound(f.next()), expected);
    assert.deepEqual(f.transport(), before);
    assert.deepEqual(f.writes(), writes);
    assert.equal(fs.existsSync(worktree(f.issue)), false);
  });
}

test("lane setup failure retains authenticated receipt, checkout, slot and readiness barrier", () => {
  const f = boundFixture(SETUP, {
    extra: { laneSlots: 1, commands: { test: "true", setup: "exit 7" } },
  });
  assert.throws(() => f.claimBound(), SETUP_FAILED);
  const saved = f.read();
  assert.equal(saved?.execution?.instance, f.cfg.execution?.instance);
  assert.equal(fs.existsSync(path.join(worktree(f.issue), ".git")), true);
  assert.equal(
    fs.existsSync(path.join(runDir(f.issue), "setup-at-claim.log")),
    true,
  );
  assert.throws(
    () => assertCheckoutReady(f.cfg, f.issue, worktree(f.issue)),
    NOT_READY,
  );
  f.guard().release();
  const before = f.writes();
  assert.throws(() => f.claimBound(f.next()), NOT_READY);
  assert.deepEqual(f.writes(), before);
});

test("a released owner cannot bypass unresolved stop recovery evidence", () => {
  const f = boundFixture(RECOVERY);
  const state = f.claim();
  f.guard().release();
  const evidence = stopRecovery(f.cfg, {
    number: f.issue,
    state,
    code: "conflict",
    reason: "retained failure",
  });
  const text = fs.readFileSync(evidence.file, "utf8");
  const before = f.writes();
  assert.throws(() => f.claimBound(f.next()), HELD);
  assert.equal(fs.readFileSync(evidence.file, "utf8"), text);
  assert.deepEqual(f.writes(), before);
});

test("missing queued PR metadata fails rather than becoming a successful answered resume", () => {
  const f = boundFixture(MISSING_PR);
  const state = f.claim();
  f.save({ ...state, pr: PR, asked: { inputs: "old" } });
  f.guard().release();
  assert.throws(() => f.claimBound(f.next()), MISSING_REPLY);
  assert.equal(fs.existsSync(worktree(f.issue)), false);
  assert.equal(
    f
      .transport()
      .comments.filter((item) => item.body.includes("agent-pipeline:state"))
      .length,
    1,
  );
});
