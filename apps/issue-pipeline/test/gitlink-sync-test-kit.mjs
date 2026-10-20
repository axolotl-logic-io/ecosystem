// @ts-check
// Divergent local gitlinks and guarded ops requests, without an initialized submodule.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";
import { sh } from "./ops-run-test-kit.mjs";
import { addWiki, pinAt } from "./wiki-pin-test-kit.mjs";

const REPLY = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  conflict: z.boolean().optional(),
  conflicts: z.array(z.string()).optional(),
  changed: z.boolean().optional(),
  resolved: z.boolean().optional(),
  baseSha: z.string().optional(),
  reason: z.string().optional(),
});

/** @param {string} wt @param {string} pin @param {string} [file] @returns {void} */
function stagePin(wt, pin, file = "wiki") {
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

/** @param {string} name */
async function gitlinkSyncFixture(name) {
  const fx = await opsFixture(name);
  fx.fakeGh.requireReplies();
  addWiki(fx);
  const config = fx.configWith("wiki.json", { wiki: true });
  const disabled = fx.configWith("disabled.json", { wiki: false });
  const { loadConfig } = await import("../src/config.ts");
  const { ensureWorktree } = await import("../src/checkouts.ts");
  const cfg = loadConfig(config);
  const { worktree } = fx;
  const seed = path.join(fx.root, "seed");
  const wikiSeed = path.join(fx.root, "wiki-seed");
  const wikiBase = pinAt(seed, "HEAD");
  /** @param {string} label @returns {string} */
  function wikiCommit(label) {
    sh(`git -C ${wikiSeed} checkout -q --detach ${wikiBase}`);
    fs.writeFileSync(path.join(wikiSeed, `${label}.md`), `${label}\n`);
    sh(`git -C ${wikiSeed} add . && git -C ${wikiSeed} commit -qm ${label}`);
    const sha = sh(`git -C ${wikiSeed} rev-parse HEAD`);
    sh(`git -C ${wikiSeed} push -q origin HEAD:refs/heads/${label}`);
    return sha;
  }

  /** @param {number} n @returns {string} */
  function branch(n) {
    fx.fetchClone();
    ensureWorktree(cfg, n);
    const wt = worktree(n);
    sh(`git -C ${wt} submodule deinit -q --force --all`);
    return wt;
  }

  /** @param {number} n @param {string} op @param {object} [extra] @param {string} [file] */
  function ask(n, op, extra = {}, file = config) {
    fx.fakeGh.reply([initialWriteStateReply(n), historyReply(n)]);
    return REPLY.parse(
      JSON.parse(fx.ask({ op, number: n, keepConflict: true, ...extra }, file)),
    );
  }

  return {
    fx,
    seed,
    wikiSeed,
    disabled,
    branch,
    wikiCommit,
    stagePin,
    ask,
    unmerged,
    resolveText,
  };
}

export { gitlinkSyncFixture };
