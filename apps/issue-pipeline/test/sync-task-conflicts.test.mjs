// @ts-check
// Sync's conflicts through the built ops (#184): a text or binary stop stays
// for a resolver and finishes as R′ containing T; a resolver that gives up or
// runs out of allowance keeps its work; a gitlink conflict is never chosen.
// The installed sync's safeguards are the ones in force (rebase.ts,
// code-recovery.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  commitFile,
  gitIn,
  inRebase,
  originContains,
  recoveryOf,
  syncWorld,
  unmerged,
} from "./sync-task-test-kit.mjs";
import { runId, statusOf } from "./task-results-test-kit.mjs";

const ISSUE = 7;
const GREETING = { file: "greet.txt", bytes: "hello from the issue\n" };
const GITLINK = /unsupported gitlink conflict at "vendor"/u;
const NOT_LATEST = /is not the latest Sync attempt/u;
const RETAINED_SYNC = /a retained synchronization is in the checkout/u;
// Bytes git treats as binary: each side's version of logo.bin.
const BASE_LOGO = Buffer.from("\u0000base logo\u00ff", "latin1");
const MY_LOGO = Buffer.from("\u0000my logo\u00fe", "latin1");
const TARGET_LOGO = Buffer.from("\u0000target logo\u00fd", "latin1");

/** @param {ReturnType<typeof syncWorld>} world */
function conflictedSync(world) {
  const target = world.advanceTarget("greet.txt", "hello from the target\n");
  const bound = world.binding(target);
  const run = runId();
  const reply = world.sync("sync-task", {
    binding: bound,
    run: { id: run, previous: null },
  });
  return { target, bound, run, reply };
}

test("a text conflict stays for a resolver, and its staged resolution finishes as R′ containing T", () => {
  const world = syncWorld(ISSUE, GREETING);
  const { target, bound, run, reply } = conflictedSync(world);
  assert.partialDeepStrictEqual(reply, {
    conflict: true,
    conflicts: ["greet.txt"],
  });
  assert.ok(inRebase(world.wt));
  assert.equal(
    world.remoteBranch(),
    world.revision,
    "nothing is pushed at a stop",
  );
  assert.partialDeepStrictEqual(statusOf(world.flow, ISSUE, bound), {
    status: "unknown",
    run,
  });
  // Only the run that stopped may finish its rebase.
  const stranger = world.sync("sync-task-finish", {
    binding: bound,
    run: { id: runId() },
  });
  assert.match(String(stranger.error), NOT_LATEST);
  assert.ok(inRebase(world.wt));
  // The resolver stages its text, as a resolver session does.
  fs.writeFileSync(path.join(world.wt, "greet.txt"), "hello from both\n");
  gitIn(world.wt, ["add", "greet.txt"]);
  const finished = world.sync("sync-task-finish", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(finished.verdict, "passed", JSON.stringify(finished));
  const produced = String(finished.produced);
  assert.equal(world.remoteBranch(), produced);
  assert.ok(originContains(world.flow.origin, target, produced));
  assert.equal(statusOf(world.flow, ISSUE, bound).status, "passed");
});

test("a resolver that gives up keeps its work in recovery, and the binding may retry", () => {
  const world = syncWorld(ISSUE, GREETING);
  const { bound, run } = conflictedSync(world);
  fs.writeFileSync(path.join(world.wt, "greet.txt"), "a rejected resolution\n");
  gitIn(world.wt, ["add", "greet.txt"]);
  const given = world.sync("sync-task-finish", {
    binding: bound,
    run: { id: run },
    cannotFix: true,
    reason: "the resolver could not reconcile the greetings",
  });
  assert.partialDeepStrictEqual(given, { verdict: "failed", retained: false });
  assert.ok(
    recoveryOf(world.flow, ISSUE).includes("commits.bundle"),
    "work saved before cleanup",
  );
  assert.equal(world.remoteBranch(), world.revision);
  assert.partialDeepStrictEqual(statusOf(world.flow, ISSUE, bound), {
    status: "missing",
    attempts: 1,
  });
  const retry = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: run },
  });
  assert.equal(retry.conflict, true, "the retry starts afresh from R");
});

test("at the resolver's limit the stopped rebase, its index and evidence are retained, never reset", () => {
  const world = syncWorld(ISSUE, GREETING);
  const { bound, run } = conflictedSync(world);
  const index = unmerged(world.wt);
  const retained = world.sync("sync-task-finish", {
    binding: bound,
    run: { id: run },
    retainConflict: true,
  });
  assert.partialDeepStrictEqual(retained, {
    verdict: "failed",
    retained: true,
  });
  assert.ok(inRebase(world.wt));
  assert.equal(unmerged(world.wt), index);
  assert.ok(recoveryOf(world.flow, ISSUE).includes("conflict-stages.json"));
  assert.equal(world.remoteBranch(), world.revision);
  // A new run can't start over the retained checkout.
  const next = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: run },
  });
  assert.match(String(next.error), RETAINED_SYNC);
  assert.ok(inRebase(world.wt));
});

test("a binary conflict goes to the resolver like text, and the chosen bytes land", () => {
  const world = syncWorld(
    ISSUE,
    { file: "logo.bin", bytes: MY_LOGO },
    (writer) => {
      commitFile(writer, "logo.bin", BASE_LOGO, "add a binary logo");
    },
  );
  const target = world.advanceTarget("logo.bin", TARGET_LOGO);
  const bound = world.binding(target);
  const run = runId();
  const reply = world.sync("sync-task", {
    binding: bound,
    run: { id: run, previous: null },
  });
  assert.partialDeepStrictEqual(reply, {
    conflict: true,
    conflicts: ["logo.bin"],
  });
  gitIn(world.wt, ["checkout", "--theirs", "--", "logo.bin"]);
  gitIn(world.wt, ["add", "logo.bin"]);
  const finished = world.sync("sync-task-finish", {
    binding: bound,
    run: { id: run },
  });
  assert.equal(finished.verdict, "passed", JSON.stringify(finished));
  assert.ok(
    originContains(world.flow.origin, target, String(finished.produced)),
  );
  assert.deepEqual(fs.readFileSync(path.join(world.wt, "logo.bin")), MY_LOGO);
});

test("a gitlink conflict names its stages, keeps the rebase and pushes nothing", () => {
  const vendor = { origin: "", base: "" };
  /** @param {string} label @returns {string} a new vendor commit */
  function vendorCommit(label) {
    const seed = `${vendor.origin}-seed-${label}`;
    gitIn(path.dirname(seed), ["clone", "-q", vendor.origin, seed]);
    const sha = commitFile(seed, `${label}.txt`, `${label}\n`, label);
    let branch = label;
    if (label === "base") {
      branch = "main";
    }
    gitIn(seed, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    return sha;
  }
  /** @param {string} wt @param {string} commit */
  function pin(wt, commit) {
    gitIn(wt, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${commit},vendor`,
    ]);
    gitIn(wt, ["commit", "-qm", `pin vendor ${commit}`]);
    return gitIn(wt, ["rev-parse", "HEAD"]);
  }
  let writerDir = "";
  const world = syncWorld(
    ISSUE,
    { file: "feature.txt", bytes: "mine\n" },
    (writer) => {
      writerDir = writer;
      vendor.origin = path.join(path.dirname(writer), "vendor.git");
      gitIn(path.dirname(writer), [
        "init",
        "-q",
        "--bare",
        "-b",
        "main",
        vendor.origin,
      ]);
      vendor.base = vendorCommit("base");
      gitIn(writer, ["submodule", "add", "-q", vendor.origin, "vendor"]);
      gitIn(writer, ["commit", "-qm", "add vendor"]);
    },
  );
  const own = vendorCommit("own");
  const revision = pin(world.wt, own);
  gitIn(world.wt, ["push", "-q", "origin", `HEAD:refs/heads/${world.branch}`]);
  const theirs = vendorCommit("theirs");
  const target = pin(writerDir, theirs);
  gitIn(writerDir, ["push", "-q", "origin", "HEAD:refs/heads/integration"]);
  const bound = world.binding(target, revision);
  const reply = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: null },
  });
  assert.equal(reply.ok, false);
  assert.match(String(reply.error), GITLINK);
  for (const [stage, sha] of [vendor.base, theirs, own].entries()) {
    assert.ok(
      String(reply.error).includes(`stage ${stage + 1}: ${sha}`),
      reply.error,
    );
  }
  assert.ok(inRebase(world.wt));
  assert.equal(world.remoteBranch(), revision);
  assert.equal(statusOf(world.flow, ISSUE, bound).status, "unknown");
});

test("a submodule the target retired leaves its folder in recovery, whole, and Sync still lands R′", () => {
  /** @type {{ origin: string }} */
  const vendor = { origin: "" };
  let writerDir = "";
  const world = syncWorld(
    ISSUE,
    { file: "feature.txt", bytes: "mine\n" },
    (writer) => {
      writerDir = writer;
      const parent = path.dirname(writer);
      vendor.origin = path.join(parent, "retired.git");
      const seed = path.join(parent, "retired-seed");
      gitIn(parent, ["init", "-q", "--bare", "-b", "main", vendor.origin]);
      gitIn(parent, ["clone", "-q", vendor.origin, seed]);
      commitFile(seed, "kept.txt", "a retired library's bytes\n", "library");
      gitIn(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
      gitIn(writer, ["submodule", "add", "-q", vendor.origin, "vendor"]);
      gitIn(writer, ["commit", "-qm", "add vendor"]);
    },
  );
  gitIn(world.wt, ["submodule", "update", "-q", "--init"]);
  gitIn(writerDir, ["rm", "-q", "vendor"]);
  gitIn(writerDir, ["commit", "-qm", "retire vendor"]);
  gitIn(writerDir, ["push", "-q", "origin", "HEAD:refs/heads/integration"]);
  const target = gitIn(writerDir, ["rev-parse", "HEAD"]);
  const bound = world.binding(target);
  const reply = world.sync("sync-task", {
    binding: bound,
    run: { id: runId(), previous: null },
  });
  assert.equal(reply.verdict, "passed", JSON.stringify(reply));
  assert.ok(originContains(world.flow.origin, target, String(reply.produced)));
  const recovery = path.join(
    world.flow.root,
    "runs",
    "o__r",
    `issue-${ISSUE}`,
    "recovery",
  );
  const kept = fs
    .readdirSync(recovery, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith("kept.txt"));
  assert.equal(kept.length, 1, "the leftover folder moved into recovery");
  assert.equal(gitIn(world.wt, ["status", "--porcelain"]), "");
});
