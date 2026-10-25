// @ts-check
// The ops CLI tests' issue-execution ownership on the scripted fake gh
// (fake-gh.mjs, #169). It stores exactly the coordination records, token
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

const SHA_LENGTH = 40;
const BASE_SHA = "b".repeat(SHA_LENGTH);
const BASE_TREE = "c".repeat(SHA_LENGTH);
const OWNER = new URL("./fake-ownership-owner.mjs", import.meta.url).pathname;
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

// fake-gh.mjs's script serves ownership through fake-ownership-gh.cjs.
const OWNERSHIP_GH = `const ownershipListing = require(${JSON.stringify(
  new URL("./fake-ownership-gh.cjs", import.meta.url).pathname,
)}).serveOwnership(dir, args, identity[2]);
`;

// The fake gh this test process installed (fake-gh.mjs registers it), and
// each issue's owner by config, issue and checkout.
let fakeDir = "";
/** @type {Map<string, { execution: any, checkout: object }>} */
const owners = new Map();

/** @param {string} dir @returns {void} */
function registerFake(dir) {
  fakeDir = dir;
}

// A test queued a new GitHub (fake-gh.mjs's reply): the next request is a
// new job's, which acquires afresh.
function forgetOwners() {
  owners.clear();
}

/**
 * @param {(store: any) => void} change
 * @returns {any}
 */
function changeStore(change) {
  const file = path.join(fakeDir, "ownership.json");
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  change(store);
  fs.writeFileSync(file, JSON.stringify(store));
  return store;
}

// A coordination store with nothing the real transport wrote yet: only the
// base commit its token commits descend from.
/** @param {{ repo: string, baseBranch: string }} cfg @returns {void} */
function freshStore({ repo, baseBranch }) {
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
  fs.writeFileSync(path.join(fakeDir, "ownership.json"), JSON.stringify(store));
}

// Whether a scripted listing of issue `n`'s comments holds saved state,
// which an earlier run must have saved.
/** @param {number} n @returns {boolean} */
function hasSavedState(n) {
  const replies = JSON.parse(
    fs.readFileSync(path.join(fakeDir, "replies.json"), "utf8"),
  );
  return replies.some(
    (/** @type {{ when: string, stdout?: string }} */ { when, stdout = "" }) =>
      when.includes(`issues/${n}/comments?`) &&
      stdout.includes("agent-pipeline:state"),
  );
}

/**
 * Acquires issue execution for a new invocation on the frame's lane, as a
 * claim names it, through the real transport, as a stage job does before
 * its first op, on a fresh store. An issue with saved state first gets the
 * released earlier run that saved it (RELEASED_RECEIPT).
 * @param {{ config: string, root: string, frame: { number: number, lane: string, checkout: { issue: number, dir: string, branch: string } } }} where
 * @returns {{ execution: any, checkout: object }}
 */
function acquire({ config, root, frame }) {
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
  /** @param {string} mode @param {object} input @returns {string} */
  function run(mode, input) {
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
  const execution = JSON.parse(run("owner", request));
  changeStore((store) => {
    store.acquiring = false;
    store.request = { ...request, execution };
  });
  return { execution, checkout: frame.checkout };
}

// Whether `checkout` is one a stage job could send for issue `n`.
/** @param {unknown} checkout @param {number} n @returns {boolean} */
function jobCheckout(checkout, n) {
  if (checkout === undefined) {
    return true;
  }
  const { issue, dir, branch } = /** @type {Record<string, unknown>} */ (
    checkout ?? {}
  );
  return (
    issue === n &&
    typeof dir === "string" &&
    dir !== "" &&
    typeof branch === "string" &&
    branch !== ""
  );
}

/**
 * An ops request's fields the binding reads, and whatever else it carries.
 * @typedef {{ number?: number, comments?: { number?: number }[], checkout?: object, config?: string, lane?: unknown, [field: string]: unknown }} OpsRequest
 */

/**
 * `request` as a stage job sends it (#169): carrying the binding of an
 * invocation that owns its issue, and that issue's checkout, by default the
 * issue's worktree under `root` on its legacy branch. A request naming no
 * issue, already bound or with a checkout no job would send, or one sent
 * from a process with no fake gh, goes as it is; so does one whose issue
 * can't be acquired, such as for a branch no job could have.
 * @param {{ config: string, root: string, request: object }} where
 * @returns {object}
 */
function bindOpsRequest({ config, root, request: sent }) {
  const request = /** @type {OpsRequest} */ (sent);
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
    } catch {
      return request;
    }
    owners.set(key, owner);
  }
  return {
    ...request,
    number: n,
    checkout: owner.checkout,
    execution: owner.execution,
  };
}

/**
 * Runs `send` with `request` bound to a new owner of its issue on any fake
 * GitHub that serves the real transport, such as the full-flow world: it
 * acquires as a stage job does, and releases after, so the next job can
 * acquire. The checkout is the issue's worktree on its legacy branch.
 * @template T
 * @param {{ config: string, env: NodeJS.ProcessEnv, request: object }} where
 * @param {(request: object) => T} send
 * @returns {T}
 */
function ownedRequest({ config, env, request: sent }, send) {
  const request = /** @type {OpsRequest} */ (sent);
  const n = request.number;
  if (typeof n !== "number" || "execution" in request) {
    return send(request);
  }
  const { repo } = JSON.parse(fs.readFileSync(config, "utf8"));
  const { ISSUE_PIPELINE_ROOT: root = "" } = env;
  const checkout = {
    issue: n,
    dir: path.join(root, "work", repo.replace("/", "__"), `issue-${n}`),
    branch: `agent/issue-${n}`,
  };
  const frame = { config, number: n, lane: "L", checkout };
  /** @param {string} mode @param {object} input @returns {string} */
  function owner(mode, input) {
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

  const execution = JSON.parse(owner("owner", frame));
  try {
    return send({ ...request, checkout, execution });
  } finally {
    owner("release", { ...frame, execution });
  }
}

/**
 * The receipt a bound claim saves for the current owner: its request's
 * record and its instance.
 * @returns {{ protocol: 1, request: number, instance: string }}
 */
function ownerReceipt() {
  const store = JSON.parse(
    fs.readFileSync(path.join(fakeDir, "ownership.json"), "utf8"),
  );
  const { instance } = store.request.execution;
  const request = ownershipRecords().find(
    (record) =>
      record.kind === "request" && record.identity.instance === instance,
  );
  return { protocol: 1, request: request.id, instance };
}

/**
 * Issue `issue`'s coordination records as its comment listing shows them.
 * @param {number} issue
 * @returns {object[]}
 */
function ownershipComments(issue) {
  const file = path.join(fakeDir, "ownership.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  return store.comments.filter(
    (/** @type {{ issue: number }} */ item) => item.issue === issue,
  );
}

// A successor takes the issue just after the next request's ownership
// check, so that request's writes find the issue no longer theirs.
function loseOwnership() {
  changeStore((store) => {
    store.takeover = true;
  });
  owners.clear();
}

/**
 * The coordination records the real transport wrote, parsed, in order.
 * @returns {any[]}
 */
function ownershipRecords() {
  const store = JSON.parse(
    fs.readFileSync(path.join(fakeDir, "ownership.json"), "utf8"),
  );
  return store.comments.map(
    (/** @type {{ id: number, body: string }} */ { id, body }) => ({
      id,
      ...JSON.parse(body.split("\n")[1] ?? "null"),
    }),
  );
}

export {
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
