// @ts-check
// A job's invocation binding is immutable at its privileged entry points
// (#168): the real ops CLI's claim, save-state and release envelopes refuse
// a request that changes any binding field, and the steer and push requests
// on the live job's control socket also one that drops it, with no effect. The owner is a real job waiting in its writer session, against
// the private fake GitHub (fake-job-coordination.mjs).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "../bounded-test-kit.mjs";
import { IMPLEMENTOR_SESSION, implementReplies } from "../job-fixtures.mjs";
import {
  logOf,
  piCommands,
  runRealOps,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";

const { ghIsRead } = await import("../../src/github.ts");

/** @import { Place } from "./job-test-kit.mjs" */

const OWNER_ARGS = ["--stage", "implement", "--lane", "L"];
const ISSUE = 7;
const OTHER_ISSUE = 8;

// Each way a request's binding can differ from the owner's.
/** @type {Record<string, (binding: any) => any>} */
const CHANGES = {
  instance: (b) => ({ ...b, instance: randomUUID() }),
  lane: (b) => ({ ...b, lane: "M" }),
  repo: (b) => ({ ...b, repo: "o/other" }),
  base: (b) => ({ ...b, base: "other-base" }),
  issue: (b) => ({ ...b, issue: OTHER_ISSUE }),
  branch: (b) => ({ ...b, branch: "agent/other" }),
  missing: () => undefined,
};

/** @param {Place} place @returns {{ writes: string[][], coordination: string }} what a refusal must not change */
function effectsOf(place) {
  const log = path.join(place.root, "gh.log");
  /** @type {string[][]} */
  let calls = [];
  if (fs.existsSync(log)) {
    calls = fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return {
    writes: calls.filter((args) => !ghIsRead(args)),
    coordination: fs.readFileSync(
      path.join(place.root, "coordination.json"),
      "utf8",
    ),
  };
}

/**
 * Sends one control request to the job's socket; resolves to its reply.
 * @param {string} socket @param {object} request @returns {Promise<any>}
 */
function control(socket, request) {
  return new Promise((resolve, reject) => {
    let text = "";
    const connection = net.createConnection(socket);
    connection.setEncoding("utf8");
    connection.on("error", reject);
    connection.on("data", (chunk) => {
      text += chunk;
    });
    connection.on("end", () => resolve(JSON.parse(text)));
    connection.write(`${JSON.stringify(request)}\n`);
  });
}

/** @param {Place} place */
async function liveOwner(place) {
  const owner = startJob(place, OWNER_ARGS);
  await waitFor("the owner's writer session got its prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
  const [claim] = logOf(place, "ops.log");
  return { owner, claim };
}

test("the claim, save-state and release envelopes refuse a changed binding field with no effect", async () => {
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const { owner, claim } = await liveOwner(place);
  const state = JSON.parse(
    fs.readFileSync(path.join(place.root, "authority-state.json"), "utf8"),
  );
  const frame = {
    config: place.config,
    sweepId: claim.sweepId,
    lane: claim.lane,
    checkout: claim.checkout,
    number: ISSUE,
  };
  const envelopes = {
    claim: { op: "claim", stage: "implement" },
    "save-state": { op: "save-state", state },
    release: { op: "release", state },
  };
  for (const [op, body] of Object.entries(envelopes)) {
    // An unbound request is the ops CLI's own legacy path, which #169's
    // per-write fencing closes; a job never sends one.
    const fields = Object.entries(CHANGES).filter(
      ([field]) => field !== "missing",
    );
    for (const [field, change] of fields) {
      const before = effectsOf(place);
      const execution = change(claim.execution);
      const reply = runRealOps(place, { ...frame, ...body, execution });
      assert.equal(reply?.ok, false, `${op} ${field}`);
      assert.deepEqual(effectsOf(place), before, `${op} ${field}`);
    }
  }
  owner.child.kill("SIGTERM");
  await owner.end;
});

test("steer and push requests on the control socket refuse a changed or missing binding with no effect", async () => {
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const { owner, claim } = await liveOwner(place);
  const { socket, launches } = statusOf(place);
  const { key } = launches.find(
    (/** @type {{ kind: string }} */ launch) => launch.kind === "session",
  );
  const pushes = path.join(place.runDir, "pushes.jsonl");
  const replies = await Promise.all(
    Object.entries(CHANGES).map(async ([field, change]) => {
      const execution = change(claim.execution);
      const steer = await control(socket, {
        type: "steer",
        key,
        message: "stale steer",
        execution,
      });
      const push = await control(socket, { type: "push", key, execution });
      return { field, steer, push };
    }),
  );
  for (const { field, steer, push } of replies) {
    assert.equal(steer.ok, false, `steer ${field}`);
    assert.equal(push.pushed, "none", `push ${field}`);
    assert.notEqual(push.pushError, null, `push ${field}`);
  }
  assert.deepEqual(
    piCommands(place).filter(({ type }) => type === "steer"),
    [],
  );
  assert.equal(fs.existsSync(pushes), false);
  // The owner's own binding still steers its live session.
  const steer = await control(socket, {
    type: "steer",
    key,
    message: "current steer",
    execution: claim.execution,
  });
  assert.equal(steer.ok, true, steer.error);
  assert.equal((await owner.end).status, 0);
});
