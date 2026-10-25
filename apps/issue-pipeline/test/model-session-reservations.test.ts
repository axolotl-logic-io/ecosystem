// Model-session reservations (src/runtime/reservations.ts) through real
// process boundaries: each invocation is its own driver process
// (reservation-driver.ts) with a real config file, credential file and run
// folder, and every GitHub call goes through the real transport to a fake
// `gh` executable (fake-coordination-gh.ts) whose store all of them share.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { z } from "zod";
import type { Store } from "./fake-coordination-gh.ts";
import {
  newStore,
  readStore,
  writeFakeGh,
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
const LEGACY_ISSUE = 70;
const READER_ISSUE = 71;
const CONTENDED_CAP = 2;
const UNVERSIONED_ISSUE = 72;
const MALFORMED_ISSUE = 99;
const UNTRUSTED_ISSUE = 98;
const UNREADABLE_RECORD = /unreadable record/u;
const UNTRUSTED_AUTHOR = /untrusted author/u;
const UNCERTAIN = /uncertain/u;
const RECONCILIATION = /reconciliation required/u;
const ALREADY_DONE = /already reported done/u;
const VERSION_MISMATCH = /record version does not match its scope/u;

const folders: string[] = [];
after(() => {
  for (const folder of folders) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

interface World {
  config: string;
  store: string;
  env: NodeJS.ProcessEnv;
}

function world(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservations-"));
  folders.push(dir);
  const bin = path.join(dir, "bin");
  writeFakeGh(bin);
  const store = path.join(dir, "github.json");
  writeStore(store, newStore(REPO, LANDING, BASE));
  const credentials = path.join(dir, "credentials.env");
  fs.writeFileSync(
    credentials,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
    { mode: PRIVATE_FILE },
  );
  const config = path.join(dir, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: REPO,
      devAccount: "dev-bot",
      landingAccount: LANDING,
      credentialsEnvFile: credentials,
      allowedUsers: ["alice"],
      baseBranch: BASE,
      commands: { test: "true" },
    }),
  );
  // Every command runs in the pipeline root, as on an installed machine.
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const { PATH: searched = "" } = process.env;
  return {
    config,
    store,
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["PATH", `${bin}${path.delimiter}${searched}`],
        ["ISSUE_PIPELINE_ROOT", root],
        ["FAKE_GH_STORE", store],
      ]),
    },
  };
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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DRIVER], { env: at.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
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
}

const RECORD = z.looseObject({
  kind: z.string(),
  scope: z.string(),
  version: z.number(),
  request: z.number().optional(),
  binding: z.object({ instance: z.string() }).optional(),
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

test("concurrent invocations in separate processes fill the cap once and leave no waiting request", async () => {
  const at = world();
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

test("a reservation outlives its process and is released only once every registered consumer reports done", async () => {
  const at = world();
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

test("a lost done report and malformed or untrusted records keep the slot held", async () => {
  const at = world();
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

  const fresh = world();
  seed(fresh, UNTRUSTED_ISSUE, "mallory", `${HEADER}{}${END}`);
  const [untrusted] = await invoke(fresh, contender, [
    { do: "reserve", cap: 1 },
  ]);
  assert.equal(untrusted?.state, "held");
  assert.match(untrusted?.reason ?? "", UNTRUSTED_AUTHOR);
});

test("old record bytes stay readable, but a resource record without its version grants nothing", async () => {
  const at = world();
  const legacy = newInvocation(LEGACY_ISSUE);
  const branch = `agent/issue-${legacy.issue}`;
  const scope = JSON.stringify([REPO, BASE, "issue", legacy.issue, branch]);
  const request = seedRecord(at, legacy.issue, {
    version: 1,
    scope,
    operation: crypto.randomUUID(),
    kind: "request",
    identity: {
      instance: legacy.instance,
      lane: "lane-70",
      issue: legacy.issue,
      branch,
      repo: REPO,
      base: BASE,
    },
    token: "a".repeat(SHA_WIDTH),
  });
  seedRecord(at, legacy.issue, {
    version: 1,
    scope,
    operation: crypto.randomUUID(),
    kind: "cancel",
    request,
    instance: legacy.instance,
  });
  const reader = newInvocation(READER_ISSUE);
  const [readable] = await invoke(at, reader, [{ do: "reserve", cap: 1 }]);
  assert.equal(readable?.state, "reserved");

  const fresh = world();
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
