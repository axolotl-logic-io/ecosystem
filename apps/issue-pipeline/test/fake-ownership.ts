// The ops CLI tests' issue-execution ownership on the scripted fake gh
// (fake-gh.ts, #169). It stores exactly the coordination records, token
// commits and epoch refs the real transport (src/execution.ts) writes, and
// never synthesizes a request, a confirmation or a release. Its own calls
// stay out of the scripted call log, so a test's reads and writes are what
// its op did. A comment listing gets the issue's coordination records after
// the scripted comments, and leaves that scripted reply queued: every
// ownership read lists the comments again.
//
// takeover() makes a successor take the issue just after the next ownership
// read is answered: the owner's check passes on what it read, and its next
// fresh read sees the successor. That is how a test loses ownership just
// before a mutation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  Record as CoordinationRecord,
  InvocationBinding,
} from "../src/coordination-records.ts";
import { armTakeover } from "./fake-ownership-takeover.ts";

const SHA_LENGTH = 40;
const BASE_SHA = "b".repeat(SHA_LENGTH);
const BASE_TREE = "c".repeat(SHA_LENGTH);
const OWNER: string = new URL("./fake-ownership-owner.ts", import.meta.url)
  .pathname;
// The run every acquisition follows: it held the issue and released it, so
// state it saved carries this receipt (the store's first record is its
// request). A bound claim resumes such state only after that release.
const FIRST_RECORD = 800_001;
const EARLIER = "00000000-0000-4000-8000-000000000001";
const RELEASED_RECEIPT = Object.freeze({
  protocol: 1,
  request: FIRST_RECORD,
  instance: EARLIER,
});

// fake-gh.ts's script serves ownership through fake-ownership-gh.ts.
const OWNERSHIP_GH = `const ownershipListing = require(${JSON.stringify(
  new URL("./fake-ownership-gh.ts", import.meta.url).pathname,
)}).serveOwnership(dir, args, identity[2]);
`;

// The fake gh this test process installed (fake-gh.ts registers it), and
// each issue's owner by config, issue and checkout.
let fakeDir = "";
// The takeover loseOwnership() armed for the next bound request, if any.
let losing: { afterWrite: boolean } | null = null;
// Why the last acquisition failed, so that request went unbound.
let refusal = "";
// An acquired owner: the binding it acquired with, and its checkout.
interface Owner {
  execution: InvocationBinding;
  checkout: object;
}
// A coordination record the real transport wrote, with its comment's id.
type OwnershipRecord = CoordinationRecord & { id: number };
// The coordination store in ownership.json that fake-ownership-gh.ts serves.
interface OwnershipStore {
  repo: string;
  base: string;
  owner: string;
  refs: Record<string, string>;
  commits: Record<string, unknown>;
  comments: { id: number; issue: number; body: string }[];
  seq: number;
  token: number;
  acquiring: boolean;
  takeover: boolean;
  afterWrite?: boolean;
  request: object | null;
}
const owners: Map<string, Owner> = new Map();

function registerFake(dir: string): void {
  fakeDir = dir;
}

// A test queued a new GitHub (fake-gh.ts's reply): the next request is a
// new job's, which acquires afresh.
function forgetOwners(): void {
  owners.clear();
  refusal = "";
}

// Why the last acquisition since reply() failed, or "" when none did.
function acquisitionRefusal(): string {
  return refusal;
}

function changeStore(change: (store: OwnershipStore) => void): OwnershipStore {
  const file = path.join(fakeDir, "ownership.json");
  const store: OwnershipStore = JSON.parse(fs.readFileSync(file, "utf8"));
  change(store);
  fs.writeFileSync(file, JSON.stringify(store));
  return store;
}

// A coordination store with nothing the real transport wrote yet: only the
// base commit its token commits descend from.
// dir: the fake's folder
function freshStore(
  { repo, baseBranch }: { repo: string; baseBranch: string },
  dir: string = fakeDir,
): void {
  const store = {
    repo,
    base: baseBranch,
    owner: OWNER,
    refs: { [`heads/${baseBranch}`]: BASE_SHA },
    commits: { [BASE_SHA]: { sha: BASE_SHA, tree: { sha: BASE_TREE } } },
    comments: [],
    seq: FIRST_RECORD - 1,
    token: 0,
    acquiring: false,
    takeover: false,
    request: null,
  };
  fs.writeFileSync(path.join(dir, "ownership.json"), JSON.stringify(store));
}

// Whether a scripted listing of issue `n`'s comments holds saved state,
// which an earlier run must have saved.
function hasSavedState(n: number): boolean {
  const file = path.join(fakeDir, "replies.json");
  if (!fs.existsSync(file)) {
    return false;
  }
  const replies = JSON.parse(fs.readFileSync(file, "utf8"));
  return replies.some(
    ({ when, stdout = "" }: { when: string; stdout?: string }) =>
      when.includes(`issues/${n}/comments?`) &&
      stdout.includes("agent-pipeline:state"),
  );
}

// Acquires issue execution for a new invocation on the frame's lane, as a
// claim names it, through the real transport, as a stage job does before
// its first op, on a fresh store. An issue with saved state first gets the
// released earlier run that saved it (RELEASED_RECEIPT).
function acquire({
  config,
  root,
  frame,
}: {
  config: string;
  root: string;
  frame: {
    number: number;
    lane: string;
    checkout: { issue: number; dir: string; branch: string };
  };
}): Owner {
  freshStore(JSON.parse(fs.readFileSync(config, "utf8")));
  changeStore((store) => {
    store.acquiring = true;
  });
  const request = { config, ...frame };
  const env = Object.fromEntries([
    ...Object.entries(process.env),
    ["ISSUE_PIPELINE_ROOT", root],
    ["HOME", root],
    ["FAKE_OWNERSHIP_QUIET", "1"],
  ]);
  function run(mode: string, input: object): string {
    const r = spawnSync(process.execPath, [OWNER, mode], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env,
    });
    if (r.status !== 0) {
      throw new Error(`${mode} #${frame.number} failed: ${r.stderr}`);
    }
    return r.stdout;
  }
  if (hasSavedState(frame.number)) {
    run("seed", { ...request, instance: EARLIER });
  }
  const execution: InvocationBinding = JSON.parse(run("owner", request));
  changeStore((store) => {
    store.acquiring = false;
    store.request = { ...request, execution };
  });
  return { execution, checkout: frame.checkout };
}

// Whether `checkout` is one a stage job could send for issue `n`.
function jobCheckout(checkout: unknown, n: number): boolean {
  if (checkout === undefined) {
    return true;
  }
  if (typeof checkout !== "object" || checkout === null) {
    return false;
  }
  const { issue, dir, branch }: Record<string, unknown> = { ...checkout };
  return (
    issue === n &&
    typeof dir === "string" &&
    dir !== "" &&
    typeof branch === "string" &&
    branch !== ""
  );
}

// An ops request's fields the binding reads, and whatever else it carries.
interface OpsRequest {
  number?: number;
  comments?: { number?: number }[];
  checkout?: object;
  config?: string;
  lane?: unknown;
  [field: string]: unknown;
}

// `request` as a stage job sends it (#169): carrying the binding of an
// invocation that owns its issue, and that issue's checkout, by default the
// issue's worktree under `root` on its legacy branch. A request naming no
// issue, already bound or with a checkout no job would send, or one sent
// from a process with no fake gh, goes as it is; so does one whose issue
// can't be acquired, such as for a branch no job could have.
function bindOpsRequest({
  config,
  root,
  request: sent,
}: {
  config: string;
  root: string;
  request: object;
}): OpsRequest {
  const request: OpsRequest = { ...sent };
  const n = request.number ?? request.comments?.[0]?.number;
  if (
    typeof n !== "number" ||
    "execution" in request ||
    fakeDir === "" ||
    !jobCheckout(request.checkout, n)
  ) {
    return request;
  }
  const file = request.config ?? config;
  const checkout = {
    issue: n,
    dir: path.join(root, "work", "o__r", `issue-${n}`),
    branch: `agent/issue-${n}`,
    ...request.checkout,
  };
  let lane = "L";
  if (typeof request.lane === "string") {
    ({ lane } = request);
  }
  const key = JSON.stringify([file, checkout, lane]);
  let owner = owners.get(key);
  if (owner === undefined) {
    owners.clear();
    try {
      owner = acquire({
        config: file,
        root,
        frame: { number: n, checkout, lane },
      });
    } catch (error) {
      refusal = String(error);
      return request;
    }
    owners.set(key, owner);
  }
  if (losing !== null) {
    const { afterWrite } = losing;
    losing = null;
    changeStore((store) => {
      store.takeover = true;
      store.afterWrite = afterWrite;
    });
  }
  return {
    ...request,
    number: n,
    checkout: owner.checkout,
    execution: owner.execution,
  };
}

// Runs `send` with `request` bound to a new owner of its issue, as a stage
// job's is: it acquires through the real transport and releases after, so
// the next job can acquire. A fake that serves the transport itself, such
// as the full-flow world, needs no `store`; one that serves it through
// fake-ownership-gh.ts names the folder it keeps its store in. The
// checkout is the request's, else the issue's worktree on its legacy branch.
function ownedRequest<T>(
  {
    config,
    env,
    request: sent,
    store,
    lose,
  }: {
    config: string;
    env: NodeJS.ProcessEnv;
    request: object;
    store?: string;
    lose?: { bin: string; afterWrite: boolean | number } | undefined;
  },
  send: (request: object) => T,
): T {
  const request: OpsRequest = { ...sent };
  const n = request.number;
  if (typeof n !== "number" || "execution" in request) {
    return send(request);
  }
  const settings = JSON.parse(fs.readFileSync(config, "utf8"));
  const { ISSUE_PIPELINE_ROOT: root = "" } = env;
  const checkout = {
    issue: n,
    dir: path.join(
      root,
      "work",
      settings.repo.replace("/", "__"),
      `issue-${n}`,
    ),
    branch: `agent/issue-${n}`,
    ...request.checkout,
  };
  const frame = { config, number: n, lane: "L", checkout };
  function owner(mode: string, input: object): string {
    const r = spawnSync(process.execPath, [OWNER, mode], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env,
    });
    if (r.status !== 0) {
      throw new Error(`${mode} #${n} failed: ${r.stderr}`);
    }
    return r.stdout;
  }
  if (store !== undefined) {
    freshStore(settings, store);
    const file = path.join(store, "ownership.json");
    const fresh = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...fresh, acquiring: true }));
  }
  const execution = JSON.parse(owner("owner", frame));
  if (store !== undefined) {
    const file = path.join(store, "ownership.json");
    const owned = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...owned, acquiring: false }));
  }
  if (lose !== undefined) {
    armTakeover(lose.bin, {
      ...frame,
      execution,
      afterWrite: lose.afterWrite,
    });
    return send({ ...request, checkout, execution });
  }
  try {
    return send({ ...request, checkout, execution });
  } finally {
    owner("release", { ...frame, execution });
  }
}

// The receipt a bound claim saves for the current owner: its request's
// record and its instance.
function ownerReceipt(): { protocol: 1; request: number; instance: string } {
  const store = JSON.parse(
    fs.readFileSync(path.join(fakeDir, "ownership.json"), "utf8"),
  );
  const { instance } = store.request.execution;
  const request = ownershipRecords().find(
    (record) =>
      record.kind === "request" && record.identity.instance === instance,
  );
  if (request === undefined) {
    throw new Error(`no request record for instance ${instance}`);
  }
  return { protocol: 1, request: request.id, instance };
}

// Issue `issue`'s coordination records as its comment listing shows them.
function ownershipComments(issue: number): object[] {
  const file = path.join(fakeDir, "ownership.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  return store.comments.filter(
    (item: { issue: number }) => item.issue === issue,
  );
}

// A successor takes the issue just after the next bound request's
// ownership check, so that request's writes find the issue no longer
// theirs; `afterWrite`, only after its first write, so its next write does.
// The next reply() starts a new job, which acquires afresh.
function loseOwnership({
  afterWrite = false,
}: {
  afterWrite?: boolean;
} = {}): void {
  losing = { afterWrite };
}

// The coordination records the real transport wrote, parsed, in order.
function ownershipRecords(): OwnershipRecord[] {
  const store = JSON.parse(
    fs.readFileSync(path.join(fakeDir, "ownership.json"), "utf8"),
  );
  return store.comments.map(({ id, body }: { id: number; body: string }) => ({
    id,
    ...JSON.parse(body.split("\n")[1] ?? "null"),
  }));
}

export type { OwnershipRecord };
export {
  acquisitionRefusal,
  bindOpsRequest,
  forgetOwners,
  loseOwnership,
  OWNERSHIP_GH,
  ownedRequest,
  ownerReceipt,
  ownershipComments,
  ownershipRecords,
  RELEASED_RECEIPT,
  registerFake,
};
