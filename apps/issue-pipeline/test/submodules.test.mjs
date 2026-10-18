// @ts-check
// Every checkout includes the pinned submodule tree, including nested modules.
// The fails-before-fix reverted test run and its two submodule tests went
// with the mechanical test rules (src/config-legacy.ts: the reviewer judges
// tests); the clone, worktree and stage-job checkouts below keep the
// pinned-submodule guarantee.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { opsFixture } from "./ops-fixture.mjs";
import { setEnv } from "./ops-run-test-kit.mjs";

const fx = await opsFixture("submodules");
const { ensureClone, ensureWorktree, removeWorktree } = await import(
  "../src/checkouts.ts"
);
const { loadConfig } = await import("../src/config.ts");
const { closeJobCheckout } = await import("../src/job/checkout-close.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const { sh } = fx;
// Only these tests' local fixture repositories may be fetched.
setEnv("GIT_ALLOW_PROTOCOL", "file");

function seedModule() {
  const leaf = path.join(fx.root, "leaf");
  const module = path.join(fx.root, "module");
  for (const dir of [leaf, module]) {
    sh(`git init -q -b main ${dir}`);
    sh(`git -C ${dir} config user.name Seed`);
    sh(`git -C ${dir} config user.email seed@example.com`);
    fs.writeFileSync(path.join(dir, "page.md"), "pinned\n");
    sh(`git -C ${dir} add . && git -C ${dir} commit -qm base`);
  }
  sh(`git -C ${module} submodule add -q ${leaf} nested`);
  sh(`git -C ${module} commit -qm nested`);
  const seed = path.join(fx.root, "seed");
  sh(`git -C ${seed} submodule add -q ${module} reference`);
  sh(
    `git -C ${seed} commit -qm reference && git -C ${seed} push -q origin integration`,
  );
  fs.writeFileSync(path.join(module, "page.md"), "newer\n");
  sh(`git -C ${module} commit -qam newer`);
}

seedModule();
const cfg = loadConfig(fx.configWith("submodules.json", { repo: "o/modules" }));

/** @param {string} dir @returns {string[]} */
function pagesOf(dir) {
  return ["reference/page.md", "reference/nested/page.md"].map((file) =>
    fs.readFileSync(path.join(dir, file), "utf8"),
  );
}

test("the shared clone checks out pinned submodules recursively", () => {
  assert.deepEqual(pagesOf(ensureClone(cfg)), ["pinned\n", "pinned\n"]);
});

test("issue worktrees contain submodules and can be removed with them", () => {
  ensureClone(cfg);
  const dir = ensureWorktree(cfg, 1);
  assert.deepEqual(pagesOf(dir), ["pinned\n", "pinned\n"]);
  removeWorktree(cfg, 1);
  assert.equal(fs.existsSync(dir), false);
});

test("stage jobs initialize submodules even without wiki publishing enabled", async () => {
  const dirs = openJobCheckout(cfg, 2, {
    stage: "review",
    branch: "agent/issue-2",
  });
  try {
    assert.deepEqual(pagesOf(dirs.repo), ["pinned\n", "pinned\n"]);
    assert.equal(dirs.docs, null);
  } finally {
    await closeJobCheckout(
      cfg,
      2,
      { ...dirs, wiki: "read", key: "review" },
      null,
    );
  }
  assert.equal(fs.existsSync(dirs.root), false);
});

test("the shared clone refreshes submodule pins when the base branch advances", () => {
  const seed = path.join(fx.root, "seed");
  sh(
    `git -C ${seed}/reference fetch -q origin && git -C ${seed}/reference checkout -q origin/main`,
  );
  sh(`git -C ${seed} add reference && git -C ${seed} commit -qm update`);
  sh(`git -C ${seed} push -q origin integration`);
  const dir = ensureClone(cfg);
  assert.deepEqual(pagesOf(dir), ["newer\n", "pinned\n"]);
});
