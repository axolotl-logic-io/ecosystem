// @ts-check
// Wiki commits are private work too: failed mirror preservation must not delete them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  COMMIT_ENV,
  close,
  inRunDir,
  KEY,
  leaveChanges,
  openFresh,
  REGULAR_EXECUTABLE_MODE,
} from "./job-checkout-dropped-test-kit.mjs";
import { refOf } from "./job-git-test-kit.mjs";
import {
  BRANCH,
  git,
  headOf,
  ISSUE,
  root,
  write,
} from "./pipeline-commit-test-kit.mjs";

const { paths, withCheckout } = await import("../src/config.ts");
const { pushWikiBranch } = await import("../src/wiki.ts");
const MIRROR_UNAVAILABLE = /wiki mirror .+ is unavailable/u;
const { closeJobCheckout } = await import("../src/job/checkout-close.ts");

/** @param {string} dir @returns {Buffer} */
function indexBytes(dir) {
  const file = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  return fs.readFileSync(file);
}

function privateWork() {
  const job = openFresh();
  write(job.repo, "README.md", "local code commit\n");
  git(job.repo, ["commit", "-am", "Private code"], COMMIT_ENV);
  write(job.docs, "Home.md", "local wiki commit\n");
  git(job.docs, ["commit", "-am", "Private wiki"], COMMIT_ENV);
  const heads = { repo: headOf(job.repo), docs: headOf(job.docs) };
  const contents = {
    repo: leaveChanges(job.repo, "README.md"),
    docs: leaveChanges(job.docs, "Home.md"),
  };
  git(job.repo, ["update-index", "--no-assume-unchanged", "--", "wiki"]);
  const indexes = { repo: indexBytes(job.repo), docs: indexBytes(job.docs) };
  return { job, heads, contents, indexes };
}

for (const failure of [
  "missing mirror",
  "unreadable mirror",
  "locked wiki ref",
]) {
  test(`${failure} refuses all cleanup and pushes, retaining exact original code and wiki work`, async () => {
    const { job, heads, contents, indexes } = privateWork();
    const mirror = paths.wikiMirror(job.cfg);
    if (failure === "locked wiki ref") {
      const ref = path.join(mirror, "refs", "heads", `${job.branch}.lock`);
      fs.mkdirSync(path.dirname(ref), { recursive: true });
      fs.writeFileSync(ref, "operator lock\n");
    } else {
      fs.renameSync(mirror, `${mirror}.retained`);
      if (failure === "unreadable mirror") {
        fs.writeFileSync(mirror, "not a Git mirror\n");
      }
    }
    /** @type {string[]} */
    const pushes = [];
    await assert.rejects(
      closeJobCheckout(
        job.cfg,
        ISSUE,
        { ...job, wiki: "write", key: KEY },
        () => {
          pushes.push("unexpected push");
          return Promise.resolve();
        },
      ),
    );
    assert.deepEqual(pushes, []);
    assert.equal(fs.existsSync(job.root), true);
    assert.equal(refOf(job.origin, BRANCH), "");
    assert.equal(refOf(job.wikiOrigin, BRANCH), "");
    for (const name of /** @type {const} */ (["repo", "docs"])) {
      assert.equal(headOf(job[name]), heads[name]);
      assert.deepEqual(indexBytes(job[name]), indexes[name]);
      for (const [file, bytes] of contents[name]) {
        assert.deepEqual(
          fs.readFileSync(path.join(job[name], file)),
          bytes,
          file,
        );
      }
      assert.equal(
        fs.statSync(path.join(job[name], "run.sh")).mode,
        REGULAR_EXECUTABLE_MODE,
      );
      assert.equal(
        fs.existsSync(paths.droppedPatch(job.cfg, ISSUE, KEY, name)),
        true,
      );
    }
    assert.equal(
      fs.existsSync(inRunDir(job.cfg, `recovery/${KEY}-code.bundle`)),
      true,
    );
  });
}

test("successful preparation independently restores unpublished code and wiki commits plus both dirty patches", async () => {
  const { job, heads, contents } = privateWork();
  await close(job, KEY);
  const restored = {
    repo: fs.mkdtempSync(path.join(root, "code-restored-")),
    docs: fs.mkdtempSync(path.join(root, "wiki-restored-")),
  };
  git(root, [
    "clone",
    inRunDir(job.cfg, `recovery/${KEY}-code.bundle`),
    restored.repo,
  ]);
  git(root, [
    "clone",
    "--branch",
    job.branch,
    paths.wikiMirror(job.cfg),
    restored.docs,
  ]);
  for (const name of /** @type {const} */ (["repo", "docs"])) {
    assert.equal(headOf(restored[name]), heads[name]);
    git(restored[name], [
      "apply",
      "--index",
      paths.droppedPatch(job.cfg, ISSUE, KEY, name),
    ]);
    for (const [file, bytes] of contents[name]) {
      assert.deepEqual(
        fs.readFileSync(path.join(restored[name], file)),
        bytes,
        file,
      );
    }
    assert.equal(
      fs.statSync(path.join(restored[name], "run.sh")).mode,
      REGULAR_EXECUTABLE_MODE,
    );
  }
  assert.equal(refOf(job.origin, BRANCH), "");
  assert.equal(refOf(job.wikiOrigin, BRANCH), "");
  assert.equal(fs.existsSync(job.root), false);
});

test("a post-push mirror failure retains the checkout and truthful prepared evidence, not a claim of untouched dirty files", async () => {
  const { job, heads, contents } = privateWork();
  const mirror = paths.wikiMirror(job.cfg);
  /** @type {string[]} */
  const pushes = [];
  await assert.rejects(
    closeJobCheckout(
      job.cfg,
      ISSUE,
      { ...job, wiki: "write", key: KEY },
      () => {
        pushes.push("push callback");
        pushWikiBranch(
          withCheckout(job.cfg, {
            issue: ISSUE,
            dir: job.repo,
            branch: job.branch,
          }),
          ISSUE,
        );
        fs.renameSync(mirror, `${mirror}.retained`);
        return Promise.resolve();
      },
    ),
    MIRROR_UNAVAILABLE,
  );
  assert.deepEqual(pushes, ["push callback"]);
  assert.equal(fs.existsSync(job.root), true);
  assert.equal(headOf(job.repo), heads.repo);
  assert.equal(headOf(job.docs), heads.docs);
  assert.equal(refOf(job.origin, BRANCH), "");
  assert.equal(refOf(job.wikiOrigin, BRANCH), heads.docs);
  assert.equal(fs.existsSync(path.join(job.docs, "notes.txt")), false);
  git(job.docs, [
    "apply",
    "--index",
    paths.droppedPatch(job.cfg, ISSUE, KEY, "docs"),
  ]);
  for (const [file, bytes] of contents.docs) {
    assert.deepEqual(fs.readFileSync(path.join(job.docs, file)), bytes, file);
  }
  assert.equal(
    fs.existsSync(inRunDir(job.cfg, `recovery/${KEY}-code.bundle`)),
    true,
  );
  assert.equal(refOf(`${mirror}.retained`, BRANCH), heads.docs);
});
