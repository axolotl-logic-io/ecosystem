// Model-session reservations (src/runtime/reservations.ts) through real
// process boundaries: each invocation is its own driver process
// (reservation-driver.ts) with a real config file, credential file and run
// folder. Every GitHub call goes through the real transport and shared curl
// client to one fake-coordination-gh.ts service whose store they all share.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, afterEach, beforeEach, test } from "node:test";
import { z } from "zod";
import { committedPolicy } from "../support/project-policy-test-kit.ts";
import type { FakeGhTransport } from "../support/signals/fake-github-test-kit.ts";
import type { Store } from "./fake-coordination-gh.ts";
import {
  newStore,
  readStore,
  startCoordinationGitHub,
  writeStore,
} from "./fake-coordination-gh.ts";

const REPO = "o/r";
const BASE = "main";
const LANDING = "land-bot";
const DRIVER = path.join(import.meta.dirname, "reservation-driver.ts");
const HEADER = "<!-- agent-pipeline:coordination\n";
const END = "\n-->";
const PRIVATE_FILE = 0o600;
const SHA_WIDTH = 40;
const LAUNCH = "model-launch";
const RESOURCE_RECORD_VERSION = 3;
const FIRST_CONTENDER = 41;
const CONTENDERS = 4;
const CONTENDING_ISSUES: readonly number[] = Array.from(
  { length: CONTENDERS },
  (_, at) => FIRST_CONTENDER + at,
);
const HOLDER_ISSUE = 51;
const WAITER_ISSUE = 52;
const LOST_ISSUE = 61;
const CONTENDER_ISSUE = 62;
const OLD_ISSUE = 70;
const READER_ISSUE = 71;
const CONTENDED_CAP = 2;
const UNVERSIONED_ISSUE = 72;
const MALFORMED_ISSUE = 99;
const UNTRUSTED_ISSUE = 98;
const UNREADABLE_RECORD = /unreadable record/u;
const INVALID_RECORD = /invalid record/u;
const UNTRUSTED_AUTHOR = /untrusted author/u;
const UNCERTAIN = /uncertain/u;
const RECONCILIATION = /reconciliation required/u;
const ALREADY_DONE = /already reported done/u;
const VERSION_MISMATCH = /record version does not match its scope/u;
const CAPACITY_CONFLICT = /drain the pool before changing its capacity/u;
const CAPACITY_MISSING =
  /request capacity declaration does not match its version/u;
const SMALL_CAP = 1;
const LARGE_CAP = 3;
const MIXED_CAPS: readonly number[] = [
  SMALL_CAP,
  LARGE_CAP,
  SMALL_CAP,
  LARGE_CAP,
];
const FIRST_MIXED = 81;
const WIDE_HOLDER_ISSUE = 85;
const NARROW_ISSUE = 86;
const UNDECLARED_ISSUE = 87;
const TRUSTED_ISSUE = 88;
const TRUSTED_CAPACITY = /differs from the trusted repository capacity, 1$/u;

const CLEANUP_MS = 30_000;
const folders: string[] = [];
const services: FakeGhTransport[] = [];
const running: Promise<Outcome[]>[] = [];
let failed = false;
beforeEach(() => {
  if (failed || running.length > 0) {
    throw new Error(
      "a previous reservation scenario has not settled successfully",
    );
  }
});
afterEach(
  async () => {
    await Promise.allSettled(running.splice(0));
    const owned = services.splice(0);
    for (const service of owned) {
      service.stop();
    }
    await Promise.all(owned.map((service) => service.closed));
  },
  { timeout: CLEANUP_MS },
);
after(() => {
  if (failed) {
    process.stderr.write(
      `Reservation evidence retained: ${folders.join(", ")}\n`,
    );
    return;
  }
  for (const folder of folders) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

interface World {
  dir: string;
  credentials: string;
  config: string;
  store: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

// A repository config file whose committed `resources` setting is
// `resources`.
function writeConfig(
  at: { dir: string; credentials: string },
  resources: unknown,
): string {
  const id = crypto.randomUUID();
  const config = path.join(at.dir, `config-${id}.json`);
  const projectPolicy = committedPolicy(
    path.join(at.dir, `policy-${id}`),
    `https://github.com/${REPO}.git`,
    { commands: { test: "true" }, resources },
  );
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: REPO,
      devAccount: "dev-bot",
      landingAccount: LANDING,
      credentialsEnvFile: at.credentials,
      allowedUsers: ["alice"],
      baseBranch: BASE,
      projectPolicy,
    }),
  );
  return config;
}

// Another machine on the same repository, store and fake `gh`, whose
// trusted `resources` setting is `resources`.
function machine(at: World, resources: unknown): World {
  return { ...at, config: writeConfig(at, resources) };
}

// A fresh repository whose trusted model-session capacity is `modelSessions`.
function world(modelSessions: number, signal: AbortSignal): World {
  if (signal.aborted) {
    throw new Error("reservation scenario is cancelled");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservations-"));
  folders.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const store = path.join(dir, "github.json");
  writeStore(store, newStore(REPO, LANDING, BASE));
  const credentials = path.join(dir, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
    { mode: PRIVATE_FILE },
  );
  const config = writeConfig({ dir, credentials }, { modelSessions });
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const { PATH: searched = "" } = process.env;
  const at: World = {
    dir,
    credentials,
    config,
    store,
    signal,
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["PATH", `${bin}${path.delimiter}${searched}`],
        ["ISSUE_PIPELINE_ROOT", root],
        ["FAKE_GH_STORE", store],
      ]),
    },
  };
  services.push(
    startCoordinationGitHub({ root: dir, bin, store, env: at.env }),
  );
  return at;
}

type Step =
  | { do: "reserve"; cap: number }
  | { do: "register" | "done"; consumer: { kind: string; id: string } }
  | { do: "release" };

// One step's outcome, as reservation-driver.ts prints it.
const OUTCOME = z.strictObject({
  state: z.enum(["reserved", "waiting", "held"]).optional(),
  resource: z.string().optional(),
  slot: z.number().optional(),
  holder: z.string().optional(),
  released: z.boolean().optional(),
  register: z.enum(["recorded", "rejected"]).optional(),
  done: z.enum(["recorded", "rejected"]).optional(),
  reason: z.string().optional(),
});
type Outcome = z.infer<typeof OUTCOME>;

// Runs one invocation's driver process and resolves to its step outcomes.
function invoke(
  at: World,
  invocation: { instance: string; issue: number },
  steps: readonly Step[],
): Promise<Outcome[]> {
  const completion = new Promise<Outcome[]>((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER], {
      env: at.env,
      signal: at.signal,
    });
    let failure: Error | undefined;
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      if (failure !== undefined) {
        failed = true;
        reject(failure);
        return;
      }
      if (code !== 0) {
        if (at.signal.aborted) {
          failed = true;
        }
        reject(new Error(`driver exited ${String(code)}: ${err}`));
        return;
      }
      resolve(
        out
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => OUTCOME.parse(JSON.parse(line))),
      );
    });
    child.stdin.end(
      JSON.stringify({ config: at.config, ...invocation, steps }),
    );
  });
  running.push(completion);
  return completion;
}

const RECORD = z.looseObject({
  kind: z.string(),
  scope: z.string(),
  version: z.number(),
  request: z.number().optional(),
  binding: z.object({ instance: z.string() }).optional(),
  cap: z.number().optional(),
});
type SavedRecord = z.infer<typeof RECORD> & { id: number };
// The model-session slot records in the store, with their comment ids.
function slotRecords(store: Store): SavedRecord[] {
  return store.comments
    .filter((item) => item.body.startsWith(HEADER))
    .map((item) => ({
      ...RECORD.parse(JSON.parse(item.body.slice(HEADER.length, -END.length))),
      id: item.id,
    }))
    .filter((row) => row.scope.includes('"model-session"'));
}
function byText(a: string, b: string): number {
  return a.localeCompare(b);
}
function seed(at: World, issue: number, login: string, body: string): number {
  const store = readStore(at.store);
  store.seq += 1;
  store.comments.push({ issue, id: store.seq, login, body });
  writeStore(at.store, store);
  return store.seq;
}
function seedRecord(at: World, issue: number, record: unknown): number {
  return seed(at, issue, LANDING, `${HEADER}${JSON.stringify(record)}${END}`);
}
function launch(id: string): { kind: string; id: string } {
  return { kind: LAUNCH, id };
}
function newInvocation(issue: number): { instance: string; issue: number } {
  return { instance: crypto.randomUUID(), issue };
}

test("concurrent invocations in separate processes fill the cap once and leave no waiting request", async ({
  signal,
}) => {
  const at = world(CONTENDED_CAP, signal);
  const outcomes = await Promise.all(
    CONTENDING_ISSUES.map((issue) =>
      invoke(at, newInvocation(issue), [{ do: "reserve", cap: CONTENDED_CAP }]),
    ),
  );
  const firsts = outcomes.map(([line]) => OUTCOME.parse(line));
  const reserved = firsts.filter((line) => line.state === "reserved");
  const shown = JSON.stringify(firsts);
  assert.deepEqual(
    reserved.map((line) => line.slot ?? 0).sort((a, b) => a - b),
    [1, CONTENDED_CAP],
    shown,
  );
  assert.equal(
    firsts.filter((line) => line.state === "waiting").length,
    CONTENDING_ISSUES.length - CONTENDED_CAP,
    shown,
  );
  assert.deepEqual(
    reserved.map((line) => line.resource),
    ["model-session", "model-session"],
  );

  const rows = slotRecords(readStore(at.store));
  assert.ok(rows.every((row) => row.version === RESOURCE_RECORD_VERSION));
  const settled = new Set(
    rows
      .filter((row) => row.kind === "cancel" || row.kind === "confirm")
      .map((row) => row.request),
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "request" && !settled.has(row.id)),
    [],
    "every request holds a slot or was cancelled",
  );
  const holders = reserved.map((line) => line.holder ?? "").sort(byText);
  const confirmed = rows
    .filter((row) => row.kind === "confirm")
    .map(
      (row) =>
        rows.find((item) => item.id === row.request)?.binding?.instance ?? "",
    )
    .sort(byText);
  assert.deepEqual(confirmed, holders, "only the holders confirmed a slot");
});

test("a reservation outlives its process and is released only once every registered consumer reports done", async ({
  signal,
}) => {
  const at = world(1, signal);
  const holder = newInvocation(HOLDER_ISSUE);
  const other = newInvocation(WAITER_ISSUE);

  const first = await invoke(at, holder, [
    { do: "reserve", cap: 1 },
    { do: "done", consumer: launch("never-registered") },
    { do: "register", consumer: launch("s1") },
    { do: "register", consumer: launch("s1") },
    { do: "register", consumer: launch("s2") },
  ]);
  assert.deepEqual(first, [
    {
      state: "reserved",
      resource: "model-session",
      slot: 1,
      holder: holder.instance,
    },
    {
      done: "rejected",
      reason: `model-session consumer ${LAUNCH}:never-registered was never registered`,
    },
    { register: "recorded" },
    { register: "recorded" },
    { register: "recorded" },
  ]);
  const registrations = slotRecords(readStore(at.store)).filter(
    (row) => row.kind === "register",
  );
  assert.equal(registrations.length, 2, "a repeated registration adds none");

  // The holder's process ended with its consumers registered: still held.
  const [blocked] = await invoke(at, other, [{ do: "reserve", cap: 1 }]);
  assert.equal(blocked?.state, "waiting");

  const second = await invoke(at, holder, [
    { do: "reserve", cap: 1 },
    { do: "release" },
    { do: "done", consumer: launch("s1") },
    { do: "register", consumer: launch("s1") },
    { do: "release" },
    { do: "done", consumer: launch("s2") },
    { do: "done", consumer: launch("s2") },
    { do: "release" },
    { do: "release" },
  ]);
  const [found, early, doneS1, reused, partial, ...rest] = second;
  assert.equal(found?.slot, 1, "the same invocation finds its own slot");
  assert.deepEqual(early, {
    released: false,
    reason: `held for consumers not yet done: ${LAUNCH}:s1, ${LAUNCH}:s2`,
  });
  assert.deepEqual(doneS1, { done: "recorded" });
  assert.equal(reused?.register, "rejected");
  assert.match(reused?.reason ?? "", ALREADY_DONE);
  assert.deepEqual(partial, {
    released: false,
    reason: `held for consumers not yet done: ${LAUNCH}:s2`,
  });
  assert.deepEqual(rest, [
    { done: "recorded" },
    { done: "recorded" },
    { released: true, reason: "every registered consumer reported done" },
    { released: true, reason: "already released" },
  ]);

  const [freed] = await invoke(at, other, [{ do: "reserve", cap: 1 }]);
  assert.equal(freed?.state, "reserved");
  assert.equal(freed?.slot, 1);
});

test("a lost done report and malformed or untrusted records keep the slot held", async ({
  signal,
}) => {
  const at = world(1, signal);
  const holder = newInvocation(LOST_ISSUE);
  const store = readStore(at.store);
  store.failPost = '"kind":"done"';
  writeStore(at.store, store);

  const [reserved, registered, lostDone, release] = await invoke(at, holder, [
    { do: "reserve", cap: 1 },
    { do: "register", consumer: launch("s1") },
    { do: "done", consumer: launch("s1") },
    { do: "release" },
  ]);
  assert.equal(reserved?.state, "reserved");
  assert.deepEqual(registered, { register: "recorded" });
  assert.equal(lostDone?.done, "rejected");
  assert.match(lostDone?.reason ?? "", UNCERTAIN);
  assert.equal(release?.released, false);
  assert.match(release?.reason ?? "", RECONCILIATION);

  const contender = newInvocation(CONTENDER_ISSUE);
  const [waiting] = await invoke(at, contender, [{ do: "reserve", cap: 1 }]);
  assert.equal(waiting?.state, "waiting");

  seed(at, MALFORMED_ISSUE, LANDING, `${HEADER}{not json${END}`);
  const [malformed] = await invoke(at, contender, [{ do: "reserve", cap: 1 }]);
  assert.equal(malformed?.state, "held");
  assert.match(malformed?.reason ?? "", UNREADABLE_RECORD);

  const fresh = world(1, signal);
  seed(fresh, UNTRUSTED_ISSUE, "mallory", `${HEADER}{}${END}`);
  const [untrusted] = await invoke(fresh, contender, [
    { do: "reserve", cap: 1 },
  ]);
  assert.equal(untrusted?.state, "held");
  assert.match(untrusted?.reason ?? "", UNTRUSTED_AUTHOR);
});

test("a record of another version, or a resource record without its version, holds and grants nothing", async ({
  signal,
}) => {
  const at = world(1, signal);
  const old = newInvocation(OLD_ISSUE);
  const branch = `agent/issue-${old.issue}`;
  const scope = JSON.stringify([REPO, BASE, "issue", old.issue, branch]);
  seedRecord(at, old.issue, {
    version: 1,
    scope,
    operation: crypto.randomUUID(),
    kind: "request",
    identity: {
      instance: old.instance,
      lane: "lane-70",
      issue: old.issue,
      branch,
      repo: REPO,
      base: BASE,
    },
    token: "a".repeat(SHA_WIDTH),
  });
  const reader = newInvocation(READER_ISSUE);
  const [other] = await invoke(at, reader, [{ do: "reserve", cap: 1 }]);
  assert.equal(other?.state, "held");
  assert.match(other?.reason ?? "", INVALID_RECORD);

  const fresh = world(1, signal);
  seedRecord(fresh, UNVERSIONED_ISSUE, {
    version: 2,
    scope: JSON.stringify([REPO, BASE, "resource", "model-session", 1]),
    operation: crypto.randomUUID(),
    kind: "request",
    binding: {
      instance: crypto.randomUUID(),
      lane: "lane-72",
      issue: UNVERSIONED_ISSUE,
      branch: `agent/issue-${UNVERSIONED_ISSUE}`,
      repo: REPO,
      base: BASE,
    },
    token: "b".repeat(SHA_WIDTH),
  });
  const [unversioned] = await invoke(fresh, reader, [
    { do: "reserve", cap: 1 },
  ]);
  assert.equal(unversioned?.state, "held");
  assert.match(unversioned?.reason ?? "", VERSION_MISMATCH);
});

test("unrelated edited state and discussion do not block a repository's model slots", async ({
  signal,
}) => {
  const at = world(1, signal);
  seed(at, OLD_ISSUE, LANDING, "<!-- agent-pipeline:state -->\nLegacy receipt");
  seed(at, OLD_ISSUE, LANDING, "Ordinary discussion");
  const store = readStore(at.store);
  for (const comment of store.comments) {
    comment.editor = "alice";
  }
  writeStore(at.store, store);
  const [reserved, released] = await invoke(at, newInvocation(READER_ISSUE), [
    { do: "reserve", cap: 1 },
    { do: "release" },
  ]);
  assert.equal(reserved?.state, "reserved");
  assert.equal(released?.released, true);
});

for (const { label, listed, current } of [
  {
    label: "retains its marker",
    listed: `${HEADER}{}${END}`,
    current: `${HEADER}{}${END}`,
  },
  {
    label: "gains its marker",
    listed: "Ordinary discussion",
    current: `${HEADER}{}${END}`,
  },
  {
    label: "loses its marker",
    listed: `${HEADER}{}${END}`,
    current: "Ordinary discussion",
  },
]) {
  test(`an untrusted coordination edit that ${label} between listing and reread holds the pool`, async ({
    signal,
  }) => {
    const at = world(1, signal);
    const id = seed(at, OLD_ISSUE, LANDING, listed);
    const store = readStore(at.store);
    const comment = store.comments.find((item) => item.id === id);
    assert.ok(comment !== undefined);
    comment.currentBody = current;
    comment.editor = "alice";
    writeStore(at.store, store);
    const [held] = await invoke(at, newInvocation(READER_ISSUE), [
      { do: "reserve", cap: 1 },
    ]);
    assert.equal(held?.state, "held");
    assert.match(held?.reason ?? "", UNTRUSTED_AUTHOR);
    assert.equal(
      readStore(at.store).comments.some((item) =>
        item.body.includes('"model-session"'),
      ),
      false,
    );
  });
}

test("a consumer record stripped of its marker before both reads still prevents release", async ({
  signal,
}) => {
  const at = world(1, signal);
  const holder = newInvocation(HOLDER_ISSUE);
  const [reserved, registered] = await invoke(at, holder, [
    { do: "reserve", cap: 1 },
    { do: "register", consumer: launch("still-running") },
  ]);
  assert.equal(reserved?.state, "reserved");
  assert.deepEqual(registered, { register: "recorded" });
  const store = readStore(at.store);
  const record = store.comments.find((item) =>
    item.body.includes('"kind":"register"'),
  );
  assert.ok(record !== undefined);
  record.body = "Ordinary discussion";
  record.editor = "alice";
  writeStore(at.store, store);
  // Issue-local execution checks remain strict even when the repository-wide
  // read ignores ordinary discussion. The holder cannot reach release.
  await assert.rejects(
    invoke(at, holder, [{ do: "reserve", cap: 1 }, { do: "release" }]),
    UNTRUSTED_AUTHOR,
  );
  assert.equal(
    readStore(at.store).comments.some(
      (item) =>
        item.body.includes('"kind":"release"') &&
        item.body.includes('"model-session"'),
    ),
    false,
  );
});

test("a caller cap that differs from the trusted capacity holds and writes nothing", async ({
  signal,
}) => {
  const at = world(SMALL_CAP, signal);
  const caller = newInvocation(TRUSTED_ISSUE);
  const [differs] = await invoke(at, caller, [
    { do: "reserve", cap: LARGE_CAP },
  ]);
  assert.equal(differs?.state, "held");
  assert.match(differs?.reason ?? "", TRUSTED_CAPACITY);
  assert.deepEqual(slotRecords(readStore(at.store)), []);
});

test("concurrent machines whose trusted capacities differ share one pool and never hold slots under both caps", async ({
  signal,
}) => {
  const small = world(SMALL_CAP, signal);
  const large = machine(small, { modelSessions: LARGE_CAP });
  const callers = [small, large, small, large].map((at, index) => ({
    cap: MIXED_CAPS[index] ?? SMALL_CAP,
    at,
    invocation: newInvocation(FIRST_MIXED + index),
  }));
  const outcomes = await Promise.all(
    callers.map(({ cap, at, invocation }) =>
      invoke(at, invocation, [{ do: "reserve", cap }]),
    ),
  );
  const firsts = outcomes.map(([line]) => OUTCOME.parse(line));
  const shown = JSON.stringify(firsts);
  const reservedCaps = callers
    .filter((_, index) => firsts[index]?.state === "reserved")
    .map(({ cap }) => cap);
  assert.ok(new Set(reservedCaps).size <= 1, shown);
  const [held = LARGE_CAP] = reservedCaps;
  assert.ok(reservedCaps.length <= held, shown);
  assert.ok(
    firsts.every(
      (line) =>
        line.state !== "held" || CAPACITY_CONFLICT.test(line.reason ?? ""),
    ),
    shown,
  );

  const rows = slotRecords(readStore(small.store));
  assert.ok(
    rows
      .filter((row) => row.kind === "request")
      .every((row) => MIXED_CAPS.includes(row.cap ?? 0)),
    "every slot request declares its caller's cap",
  );
  for (const row of rows) {
    const [repo, base, kind, resource, slot, ...extra] = z
      .array(z.unknown())
      .parse(JSON.parse(row.scope));
    assert.deepEqual(
      { repo, base, kind, resource, extra },
      {
        repo: REPO,
        base: BASE,
        kind: "resource",
        resource: "model-session",
        extra: [],
      },
      "both caps contend in one pool: no cap in any slot scope",
    );
    assert.ok(Number.isSafeInteger(slot));
  }
  const ended = new Set(
    rows
      .filter((row) => row.kind === "cancel" || row.kind === "release")
      .map((row) => row.request),
  );
  const liveCaps = new Set(
    rows
      .filter((row) => row.kind === "request" && !ended.has(row.id))
      .map((row) => row.cap),
  );
  assert.ok(liveCaps.size <= 1, `live claims under one cap: ${shown}`);
});

test("after the trusted capacity changes, callers hold until the pool drains, and released history doesn't constrain it", async ({
  signal,
}) => {
  const wideAt = world(LARGE_CAP, signal);
  const narrowAt = machine(wideAt, { modelSessions: SMALL_CAP });
  const wide = newInvocation(WIDE_HOLDER_ISSUE);
  const narrow = newInvocation(NARROW_ISSUE);
  const [reserved, registered] = await invoke(wideAt, wide, [
    { do: "reserve", cap: LARGE_CAP },
    { do: "register", consumer: launch("s1") },
  ]);
  assert.equal(reserved?.state, "reserved");
  assert.deepEqual(registered, { register: "recorded" });

  const [conflict] = await invoke(narrowAt, narrow, [
    { do: "reserve", cap: SMALL_CAP },
  ]);
  assert.equal(conflict?.state, "held");
  assert.match(conflict?.reason ?? "", CAPACITY_CONFLICT);
  const [again] = await invoke(narrowAt, wide, [
    { do: "reserve", cap: SMALL_CAP },
  ]);
  assert.equal(again?.state, "held", "the holder can't change cap either");
  assert.match(again?.reason ?? "", CAPACITY_CONFLICT);

  // The holder's handle stays usable for draining, and release still waits
  // for its consumer.
  const [, early, done, released] = await invoke(wideAt, wide, [
    { do: "reserve", cap: LARGE_CAP },
    { do: "release" },
    { do: "done", consumer: launch("s1") },
    { do: "release" },
  ]);
  assert.equal(early?.released, false);
  assert.deepEqual(done, { done: "recorded" });
  assert.equal(released?.released, true);
  const [changed] = await invoke(narrowAt, narrow, [
    { do: "reserve", cap: SMALL_CAP },
  ]);
  assert.equal(changed?.state, "reserved", "a drained pool takes a new cap");
});

test("a live slot request without a declared cap grants nothing", async ({
  signal,
}) => {
  const at = world(SMALL_CAP, signal);
  seedRecord(at, UNDECLARED_ISSUE, {
    version: RESOURCE_RECORD_VERSION,
    scope: JSON.stringify([REPO, BASE, "resource", "model-session", 1]),
    operation: crypto.randomUUID(),
    kind: "request",
    binding: {
      instance: crypto.randomUUID(),
      lane: `lane-${UNDECLARED_ISSUE}`,
      issue: UNDECLARED_ISSUE,
      branch: `agent/issue-${UNDECLARED_ISSUE}`,
      repo: REPO,
      base: BASE,
    },
    token: "c".repeat(SHA_WIDTH),
  });
  const [undeclared] = await invoke(at, newInvocation(READER_ISSUE), [
    { do: "reserve", cap: SMALL_CAP },
  ]);
  assert.equal(undeclared?.state, "held");
  assert.match(undeclared?.reason ?? "", CAPACITY_MISSING);
});
