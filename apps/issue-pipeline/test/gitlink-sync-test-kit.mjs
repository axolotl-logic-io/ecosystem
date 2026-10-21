// @ts-check
// Divergent local gitlinks and guarded ops requests, without an initialized
// submodule: the base has a `vendor` submodule of a local origin, and each
// test pins its own divergent commits of it.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";
import { sh } from "./ops-run-test-kit.mjs";
import { addSubmodule } from "./submodule-test-kit.mjs";

const REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  conflict: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  changed: z.boolean().optional(),
  resolved: z.boolean().optional(),
  baseSha: z.string().optional(),
  reason: z.string().optional(),
  retained: z.boolean().optional(),
});

/** @param {string} wt @param {string} pin @param {string} [file] @returns {void} */
function stagePin(wt, pin, file = "vendor") {
  sh(`git -C ${wt} update-index --add --cacheinfo 160000,${pin},${file}`);
}

/** @param {string} wt @returns {string} */
function unmerged(wt) {
  return sh(`git -C ${wt} ls-files --unmerged`);
}

/** @param {string} wt @param {string} file @returns {void} */
function resolveText(wt, file) {
  fs.writeFileSync(path.join(wt, file), "both intents\n");
  sh(`git -C ${wt} add -- ${file}`);
}

/**
 * Gives `fx`'s base a `vendor` submodule of a local origin with one commit,
 * and brings the pipeline's clone onto it.
 * @param {import("./ops-fixture.mjs").OpsFixture} fx
 * @returns {{ vendorOrigin: string, vendorSeed: string, vendorBase: string }}
 */
function addVendor(fx) {
  const { root } = fx;
  const seed = path.join(root, "seed");
  const vendorOrigin = path.join(root, "vendor.git");
  const vendorSeed = path.join(root, "vendor-seed");
  sh(`git init -q --bare -b main ${vendorOrigin}`);
  sh(`git clone -q ${vendorOrigin} ${vendorSeed} 2>/dev/null`);
  sh(`git -C ${vendorSeed} config user.email a@b`);
  sh(`git -C ${vendorSeed} config user.name a`);
  sh(
    `cd ${vendorSeed} && echo lib > lib.txt && git add . && git commit -qm lib`,
  );
  sh(`git -C ${vendorSeed} push -q origin HEAD:main`);
  const vendorBase = sh(`git -C ${vendorSeed} rev-parse HEAD`);
  addSubmodule(seed, vendorOrigin, "vendor");
  sh(`git -C ${seed} push -q origin integration`);
  fx.fetchClone();
  sh(`git -C ${root}/clones/o__r reset --hard origin/integration`);
  return { vendorOrigin, vendorSeed, vendorBase };
}

/** @param {string} name */
async function gitlinkSyncFixture(name) {
  const fx = await opsFixture(name);
  fx.fakeGh.requireReplies();
  const { vendorOrigin, vendorSeed, vendorBase } = addVendor(fx);
  const seed = path.join(fx.root, "seed");
  const { loadConfig } = await import("../src/config.ts");
  const { ensureWorktree } = await import("../src/checkouts.ts");
  const cfg = loadConfig(path.join(fx.root, "config.json"));

  // A new commit of the vendor origin, diverging from its first.
  /** @param {string} label @returns {string} */
  function vendorCommit(label) {
    sh(`git -C ${vendorSeed} checkout -q --detach ${vendorBase}`);
    fs.writeFileSync(path.join(vendorSeed, `${label}.txt`), `${label}\n`);
    sh(
      `git -C ${vendorSeed} add . && git -C ${vendorSeed} commit -qm ${label}`,
    );
    const sha = sh(`git -C ${vendorSeed} rev-parse HEAD`);
    sh(`git -C ${vendorSeed} push -q origin HEAD:refs/heads/${label}`);
    return sha;
  }

  /** @param {number} n @returns {string} */
  function branch(n) {
    fx.fetchClone();
    ensureWorktree(cfg, n);
    const wt = fx.worktree(n);
    sh(`git -C ${wt} submodule deinit -q --force --all`);
    return wt;
  }

  /** @param {number} n @param {string} op @param {object} [extra] */
  function ask(n, op, extra = {}) {
    fx.fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
    return REPLY.parse(
      JSON.parse(fx.ask({ op, number: n, keepConflict: true, ...extra })),
    );
  }

  return {
    fx,
    seed,
    vendorBase,
    vendorOrigin,
    branch,
    vendorCommit,
    stagePin,
    ask,
    unmerged,
    resolveText,
  };
}

export { gitlinkSyncFixture };
