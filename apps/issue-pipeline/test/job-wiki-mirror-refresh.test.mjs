// @ts-check
// Remote wiki refresh must not overwrite unpublished recovery heads.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  COMMIT_ENV,
  close,
  KEY,
  openFresh,
} from "./job-checkout-dropped-test-kit.mjs";
import { git, headOf, ISSUE, write } from "./pipeline-commit-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { openJobCheckout } = await import("../src/job/checkout.ts");
const DIVERGED = /diverg/u;

function privateWiki() {
  const job = openFresh();
  write(job.docs, "Home.md", "remote issue head\n");
  git(job.docs, ["commit", "-am", "Remote issue work"], COMMIT_ENV);
  const remote = headOf(job.docs);
  git(job.wikiOrigin, ["fetch", job.docs, `HEAD:refs/heads/${job.branch}`]);
  write(job.docs, "Home.md", "private issue head\n");
  git(job.docs, ["commit", "-am", "Private issue work"], COMMIT_ENV);
  const privateHead = headOf(job.docs);
  return { job, remote, privateHead };
}

/** @param {ReturnType<typeof privateWiki>} w */
function retainedHead(w) {
  const mirror = paths.wikiMirror(w.job.cfg);
  return git(mirror, ["rev-parse", `refs/heads/${w.job.branch}`]);
}

test("wiki refresh preserves private commits with a behind remote issue branch", async () => {
  const w = privateWiki();
  await close(w.job, KEY);
  assert.equal(retainedHead(w), w.privateHead);
  const next = openJobCheckout(w.job.cfg, ISSUE, {
    stage: "review",
    branch: w.job.branch,
  });
  assert.equal(headOf(next.docs ?? ""), w.privateHead);
  assert.equal(fs.existsSync(next.root), true);
  assert.equal(retainedHead(w), w.privateHead);
  assert.equal(
    git(w.job.wikiOrigin, ["rev-parse", `refs/heads/${w.job.branch}`]),
    w.remote,
  );
});

test("wiki refresh stops on divergence and retains both wiki heads", async () => {
  const w = privateWiki();
  git(w.job.docs, ["checkout", "--detach", w.remote]);
  write(w.job.docs, "Home.md", "divergent remote work\n");
  git(w.job.docs, ["commit", "-am", "Other wiki work"], COMMIT_ENV);
  const other = headOf(w.job.docs);
  git(w.job.wikiOrigin, [
    "fetch",
    w.job.docs,
    `+HEAD:refs/heads/${w.job.branch}`,
  ]);
  git(w.job.docs, ["checkout", w.job.branch]);
  await close(w.job, KEY);
  assert.equal(retainedHead(w), w.privateHead);
  assert.throws(
    () =>
      openJobCheckout(w.job.cfg, ISSUE, {
        stage: "review",
        branch: w.job.branch,
      }),
    DIVERGED,
  );
  assert.equal(retainedHead(w), w.privateHead);
  assert.equal(
    git(w.job.wikiOrigin, ["rev-parse", `refs/heads/${w.job.branch}`]),
    other,
  );
});
