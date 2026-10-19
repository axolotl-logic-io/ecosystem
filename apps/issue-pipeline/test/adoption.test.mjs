// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  BRANCH,
  changeApi,
  dirtyWork,
  fixture,
  git,
  readApi,
} from "./adoption-test-kit.mjs";

const ISSUE = 7;
const PR = 42;

const { PLAN } = await import("../src/adoption-plan.ts");
const { adoptLegacy } = await import("../src/adoption.ts");
const { readClaimState, readWriteState } = await import(
  "../src/saved-state.ts"
);
const { listComments } = await import("../src/comments.ts");
const { withCheckout } = await import("../src/config.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { claim } = await import("../src/ops/claim.ts");
const { recoverDraft } = await import("../src/ops/pr-state.ts");

const LEGACY_REFUSAL = /legacy pipeline state needs explicit reconciliation/u;
const RESTART = /operator must choose an explicit --restart-stage/u;
const UNAUTHORIZED = /restart stage lacks current authorization/u;
const STOPPED = /stopped for explicit PR\/completion reconciliation/u;

/** @param {string} dir */
function localSnapshot(dir) {
  return {
    head: git(dir, ["rev-parse", "HEAD"]),
    status: git(dir, ["status", "--porcelain"]),
    index: git(dir, ["show", ":local.txt"]),
    working: fs.readFileSync(path.join(dir, "local.txt"), "utf8"),
  };
}

/** @param {ReturnType<typeof fixture>} place */
function planOf(place) {
  return PLAN.parse(
    JSON.parse(
      fs.readFileSync(path.join(place.runDir, "adoption", "plan.json"), "utf8"),
    ),
  );
}

/** @param {ReturnType<typeof fixture>} place */
function currentComments(place) {
  return readApi(place).comments.filter(
    (c) => c.user?.login === place.cfg.mergeAccount,
  );
}

test("ordinary claims still refuse legacy state before claiming or initializing authority", () => {
  const place = fixture();
  const cfg = withCheckout(place.cfg, {
    issue: ISSUE,
    branch: BRANCH,
    dir: place.code,
  });
  assert.throws(
    () => claim(cfg, { number: ISSUE, lane: "caller", sweepId: "test" }),
    LEGACY_REFUSAL,
  );
  assert.equal(readApi(place).comments.length, 1);
  assert.throws(() => readWriteState(place.cfg, ISSUE), LEGACY_REFUSAL);
});

test("publication preserves unpushed code, index and working bytes, historical comments and handoffs; rerun verifies without duplicating", () => {
  const place = fixture();
  const before = dirtyWork(place.code);
  const historical = readApi(place).comments;
  const remoteRefs = git(place.origins.origin, ["show-ref"]);
  const result = place.adopt();
  assert.equal(result.reused, false);
  assert.deepEqual(localSnapshot(place.code), before);
  assert.equal(git(place.origins.origin, ["show-ref"]), remoteRefs);
  assert.deepEqual(readApi(place).comments.slice(0, 1), historical);
  assert.equal(currentComments(place).length, 1);
  const state = readWriteState(place.cfg, ISSUE);
  assert.equal(state.stage, "author");
  assert.equal(state.pr, PR);
  assert.equal(state.headSha, place.remote);
  assert.equal(state.gherkin, null);
  assert.equal(state.codeMerged, null);
  assert.equal(state.merged, null);
  assert.equal(state.hardened, null);
  assert.equal(state.integration, null);
  assert.equal(state.security, null);
  assert.equal(state.verifiedSha, null);
  assert.equal(state.review.verdict, null);
  const plan = planOf(place);
  assert.equal(plan.comments[0]?.body, historical[0]?.body);
  assert.equal(plan.work.handoffs.length, 1);
  const evidence = fs.readFileSync(result.evidence, "utf8");
  assert.equal(place.adopt().reused, true);
  assert.equal(fs.readFileSync(result.evidence, "utf8"), evidence);
  assert.equal(currentComments(place).length, 1);
  assert.ok(
    readApi(place)
      .calls.filter((args) => args[0] === "pr" && args[1] === "list")
      .every((args) => args.includes("all") && args.includes("100")),
  );
});

test("bundles and independent patches restore exact staged, working and binary snapshots", () => {
  const place = fixture();
  const before = dirtyWork(place.code);
  const original = git(place.code, [
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    place.remote,
    "-m",
    "Private original before rewrite",
  ]);
  git(place.code, ["update-ref", "ORIG_HEAD", original]);
  place.adopt();
  const plan = planOf(place);
  const tree = plan.work.trees.find((item) => item.dir === place.code);
  assert.ok(tree);
  assert.equal(tree.head, before.head);
  assert.ok(tree.unpushed.includes(before.head));
  assert.ok(tree.unpushed.includes(original));
  assert.ok(tree.refs.includes(`${original} ORIG_HEAD`));
  assert.equal(tree.patches.length, 2);
  for (const patch of tree.patches) {
    const recovery = path.join(place.tmp, path.basename(patch.file));
    git(place.tmp, ["clone", tree.bundle.file, recovery]);
    git(recovery, ["checkout", before.head]);
    git(recovery, ["apply", "--index", patch.file]);
    let bytes = "working bytes";
    if (patch.file.endsWith("index.patch")) {
      bytes = "staged bytes";
    }
    assert.equal(git(recovery, ["show", ":local.txt"]), bytes);
  }
  assert.deepEqual(
    fs.readFileSync(path.join(place.tmp, "working.patch", "binary.bin")),
    fs.readFileSync(path.join(place.code, "binary.bin")),
  );
});

test("the explicit CLI preserves before refusing a missing restart choice, and accepts no legacy approval as a later restart", () => {
  const place = fixture();
  const before = dirtyWork(place.code);
  const result = spawnSync(
    process.execPath,
    [
      new URL("../src/adopt.ts", import.meta.url).pathname,
      "--config",
      place.config,
      "--issue",
      "7",
      "--branch",
      BRANCH,
      "--code-path",
      place.code,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(JSON.parse(result.stdout).error, RESTART);
  assert.equal(currentComments(place).length, 0);
  assert.deepEqual(localSnapshot(place.code), before);
  for (const restart of ["implement", "review", "merge", "done"]) {
    assert.throws(
      () => adoptLegacy(place.cfg, { ...place.request, restart }),
      UNAUTHORIZED,
    );
  }
  assert.equal(currentComments(place).length, 0);
  assert.equal(place.adopt().state.stage, "author");
});

test("closed work is stopped and cannot launch a model or push until the existing explicit validated reopen path succeeds", () => {
  const place = fixture();
  dirtyWork(place.code);
  changeApi(place, (data) => {
    data.pr.state = "closed";
  });
  assert.throws(() => place.adopt(), UNAUTHORIZED);
  place.request.restart = "stopped";
  const result = place.adopt();
  assert.equal(result.state.codeMerged, null);
  assert.equal(result.state.stage, "stopped");
  assert.throws(
    () => readClaimState(place.cfg, ISSUE, listComments(place.cfg, ISSUE)),
    STOPPED,
  );
  assert.throws(() => readWriteAuthority(place.cfg, ISSUE));
  changeApi(place, (data) => {
    data.pr.state = "open";
  });
  assert.throws(() => readWriteAuthority(place.cfg, ISSUE));
  changeApi(place, (data) => {
    data.pr.state = "closed";
  });
  const cfg = withCheckout(place.cfg, {
    issue: ISSUE,
    dir: place.code,
    branch: BRANCH,
  });
  recoverDraft(cfg, ISSUE, PR);
  assert.equal(readWriteState(place.cfg, ISSUE).adoption?.blocked, false);
  assert.equal(readClaimState(cfg, ISSUE, listComments(cfg, ISSUE))?.pr, PR);
  assert.equal(git(place.origins.origin, ["rev-parse", BRANCH]), place.remote);
});
