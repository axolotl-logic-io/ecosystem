// @ts-check
// Every checkout includes the pinned submodule tree, including nested modules.
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
const { openJobCheckout, closeJobCheckout } = await import(
  "../src/job/checkout.ts"
);
const { revertedTest } = await import("../src/ops/fails-before-fix.ts");
const { sh } = fx;
const REVERTED_ISSUE = 3;
const SHORT_SHA_LENGTH = 8;
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

const initialBase = fx.originRef("integration");
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
  const dirs = openJobCheckout(cfg, 2, { stage: "review" });
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

test("the reverted test run has the pinned submodules and removes its worktree", () => {
  const wt = ensureWorktree(cfg, REVERTED_ISSUE);
  const sha = sh(`git -C ${wt} rev-parse HEAD`);
  const logDir = path.join(fx.root, "logs");
  fs.mkdirSync(logDir);
  const result = revertedTest(
    {
      cfg,
      number: 3,
      wt,
      sha,
      base: sha,
      logDir,
      timeoutMs: 30_000,
      label: "submodule-test",
      commands: {
        test: "test -f reference/page.md && test -f reference/nested/page.md",
      },
    },
    [],
  );
  assert.equal(result.code, 0);
  const removed = path.join(
    fx.root,
    "runs/o__modules/issue-3",
    `submodule-test-${sha.slice(0, SHORT_SHA_LENGTH)}`,
  );
  assert.equal(fs.existsSync(removed), false);
});

test("reverting a newly added submodule does not fetch its removed gitlink", () => {
  const wt = ensureWorktree(cfg, REVERTED_ISSUE);
  const sha = sh(`git -C ${wt} rev-parse HEAD`);
  const result = revertedTest(
    {
      cfg,
      number: REVERTED_ISSUE,
      wt,
      sha,
      base: initialBase,
      logDir: path.join(fx.root, "logs"),
      timeoutMs: 30_000,
      label: "without-module",
      commands: { test: "test ! -e reference && test ! -e .gitmodules" },
    },
    [".gitmodules", "reference"],
  );
  assert.equal(result.code, 0);
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
