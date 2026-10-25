// A job's invocation binding is immutable at its privileged entry points
// (#168): the real ops CLI's claim, save-state and release envelopes refuse
// a request that changes any binding field, and the steer and push requests
// on the live job's control socket also one that drops it, with no effect. The owner is a real job waiting in its writer session, against
// the private fake GitHub (fake-job-coordination.ts).
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import type { InvocationBinding } from "../../src/coordination.ts";
import type { OpsFrame } from "../../src/job/ops-request.ts";
import { waitFor } from "../bounded-test-kit.ts";
import { IMPLEMENTOR_SESSION, implementReplies } from "../job-fixtures.ts";
import type { JobEnd, OpsLine, Place } from "./job-test-kit.ts";
import {
  logOf,
  piCommands,
  runRealOps,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.ts";

const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);

const OWNER_ARGS = ["--stage", "implement", "--lane", "L"];
const ISSUE = 7;
const OTHER_ISSUE = 8;

// Each way a request's binding can differ from the owner's.
const CHANGES: Record<
  string,
  (binding: InvocationBinding) => InvocationBinding | undefined
> = {
  instance: (b: InvocationBinding) => ({ ...b, instance: randomUUID() }),
  lane: (b: InvocationBinding) => ({ ...b, lane: "M" }),
  repo: (b: InvocationBinding) => ({ ...b, repo: "o/other" }),
  base: (b: InvocationBinding) => ({ ...b, base: "other-base" }),
  issue: (b: InvocationBinding) => ({ ...b, issue: OTHER_ISSUE }),
  branch: (b: InvocationBinding) => ({ ...b, branch: "agent/other" }),
  missing: () => undefined,
};

// The claim the job sent, with the claimant its frame names.
type ClaimLine = OpsLine & Pick<OpsFrame, "sweepId">;

// What the job's control socket answers a steer or a push.
interface ControlReply {
  ok?: boolean;
  error?: string;
  pushed?: string;
  pushError?: unknown;
}

// An ops reply's `ok`; undefined for a reply that has none.
function okOf(reply: unknown): unknown {
  if (typeof reply === "object" && reply !== null && "ok" in reply) {
    return reply.ok;
  }
  return undefined;
}

// Returns what a refusal must not change
function effectsOf(place: Place): { writes: string[][]; coordination: string } {
  const log = path.join(place.root, "gh.log");
  let calls: string[][] = [];
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

// Sends one control request to the job's socket; resolves to its reply.
function control(socket: string, request: object): Promise<ControlReply> {
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

async function liveOwner(place: Place): Promise<{
  owner: { child: ChildProcess; end: Promise<JobEnd> };
  claim: ClaimLine | undefined;
}> {
  const owner = startJob(place, OWNER_ARGS);
  await waitFor("the owner's writer session got its prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
  const [claim] = logOf<ClaimLine>(place, "ops.log");
  return { owner, claim };
}

test("the claim, save-state and release envelopes refuse a changed binding field with no effect", async () => {
  const place = setUp(implementReplies(), {
    events: ["wait", ...IMPLEMENTOR_SESSION.events],
  });
  const { owner, claim } = await liveOwner(place);
  assert.ok(claim);
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
      assert.equal(okOf(reply), false, `${op} ${field}`);
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
  assert.ok(claim);
  const status = statusOf(place);
  assert.ok(status);
  const { socket, launches } = status;
  const session = launches.find((launch) => launch.kind === "session");
  assert.ok(session);
  const { key } = session;
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
