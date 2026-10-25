// Divergent local gitlinks and guarded ops requests, without an initialized
// submodule: the base has a `vendor` submodule of a local origin, and each
// test pins its own divergent commits of it.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  historyReply,
  initialWriteStateReply,
} from "../initial-write-state-fixtures.ts";
import type { OpsFixture } from "../ops-fixtures.ts";
import { opsFixture } from "../ops-fixtures.ts";
import { sh } from "../ops-run-test-kit.ts";
import { addSubmodule } from "./submodule-test-kit.ts";

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

type GitlinkReply = z.infer<typeof REPLY>;

// An ops fixture whose base has a `vendor` submodule, and the helpers its
// tests use to pin and resolve divergent gitlinks.
interface GitlinkSyncFixture {
  fx: OpsFixture;
  seed: string;
  vendorBase: string;
  vendorOrigin: string;
  branch: (n: number) => string;
  vendorCommit: (label: string) => string;
  stagePin: (wt: string, pin: string, file?: string) => void;
  ask: (n: number, op: string, extra?: object) => GitlinkReply;
  unmerged: (wt: string) => string;
  resolveText: (wt: string, file: string) => void;
}

function stagePin(wt: string, pin: string, file = "vendor"): void {
  sh(`git -C ${wt} update-index --add --cacheinfo 160000,${pin},${file}`);
}

function unmerged(wt: string): string {
  return sh(`git -C ${wt} ls-files --unmerged`);
}

function resolveText(wt: string, file: string): void {
  fs.writeFileSync(path.join(wt, file), "both intents\n");
  sh(`git -C ${wt} add -- ${file}`);
}

// Gives `fx`'s base a `vendor` submodule of a local origin with one commit,
// and brings the pipeline's clone onto it.
function addVendor(fx: OpsFixture): {
  vendorOrigin: string;
  vendorSeed: string;
  vendorBase: string;
} {
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

async function gitlinkSyncFixture(name: string): Promise<GitlinkSyncFixture> {
  const fx = await opsFixture(name);
  fx.fakeGh.requireReplies();
  const { vendorOrigin, vendorSeed, vendorBase } = addVendor(fx);
  const seed = path.join(fx.root, "seed");
  const { loadConfig } = await import("../../src/config.ts");
  const { ensureWorktree } = await import("../../src/checkouts.ts");
  const cfg = loadConfig(path.join(fx.root, "config.json"));

  // A new commit of the vendor origin, diverging from its first.
  function vendorCommit(label: string): string {
    sh(`git -C ${vendorSeed} checkout -q --detach ${vendorBase}`);
    fs.writeFileSync(path.join(vendorSeed, `${label}.txt`), `${label}\n`);
    sh(
      `git -C ${vendorSeed} add . && git -C ${vendorSeed} commit -qm ${label}`,
    );
    const sha = sh(`git -C ${vendorSeed} rev-parse HEAD`);
    sh(`git -C ${vendorSeed} push -q origin HEAD:refs/heads/${label}`);
    return sha;
  }

  function branch(n: number): string {
    fx.fetchClone();
    ensureWorktree(cfg, n);
    const wt = fx.worktree(n);
    sh(`git -C ${wt} submodule deinit -q --force --all`);
    return wt;
  }

  function ask(n: number, op: string, extra: object = {}): GitlinkReply {
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

export type { GitlinkSyncFixture };
export { gitlinkSyncFixture };
