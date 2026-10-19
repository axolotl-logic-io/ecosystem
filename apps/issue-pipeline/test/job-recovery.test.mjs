// @ts-check
// Real binary patches and durable discovery across disposable Review attempts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  COMMIT_ENV,
  close,
  inRunDir,
  leaveChanges,
  openFresh,
  openIn,
  restored,
  timedOutReview,
} from "./job-checkout-dropped-test-kit.mjs";
import { git, headOf, ISSUE, write } from "./pipeline-commit-test-kit.mjs";

const { MANIFEST, recoveryLines } = await import("../src/job/dropped-patch.ts");
const FIRST = "review-20261019T191100000Z";
const SNAPSHOT_COUNT = 4;
const SECOND = "review-20261019T194800000Z";
const TIMEOUT = {
  stage: "review",
  outcome: "stop",
  reason: "the hardening session failed: timed out before it exited",
};

/** @param {ReturnType<typeof openFresh>} job @param {string} key */
function manifest(job, key) {
  return MANIFEST.parse(
    JSON.parse(
      fs.readFileSync(inRunDir(job.cfg, `dropped/${key}.json`), "utf8"),
    ),
  );
}

test("both checkout snapshots independently restore their staged and working versions on recorded bases", async () => {
  const job = openFresh();
  const bases = { repo: headOf(job.repo), docs: headOf(job.docs) };
  leaveChanges(job.repo, "README.md");
  leaveChanges(job.docs, "Home.md");
  await close(job, FIRST, TIMEOUT);
  const first = manifest(job, FIRST);
  for (const snapshot of first.snapshots) {
    const patch = inRunDir(job.cfg, `dropped/${snapshot.file}`);
    assert.equal(snapshot.base, bases[snapshot.checkout]);
    assert.equal(snapshot.source, job[snapshot.checkout]);
    let tracked = "README.md";
    let { origin } = job;
    if (snapshot.checkout === "docs") {
      tracked = "Home.md";
      origin = job.wikiOrigin;
    }
    const fresh = restored(origin, snapshot.base, patch);
    let expected = "staged\n";
    if (snapshot.kind === "working-tree") {
      expected += "unstaged\n";
    }
    assert.equal(fs.readFileSync(path.join(fresh, tracked), "utf8"), expected);
    assert.equal(
      fs.existsSync(path.join(fresh, "blob.bin")),
      snapshot.kind === "working-tree",
    );
  }
});

test("a timed-out Review's separate snapshots remain readable and discoverable after status replacement and a further timeout", async () => {
  const job = openFresh();
  const bases = { repo: headOf(job.repo), docs: headOf(job.docs) };
  leaveChanges(job.repo, "README.md");
  leaveChanges(job.docs, "Home.md");
  await timedOutReview(job, FIRST);
  const first = manifest(job, FIRST);
  assert.equal(first.branch, job.branch);
  assert.deepEqual(first.origin, TIMEOUT);
  assert.equal(first.job, FIRST);
  assert.equal(first.snapshots.length, SNAPSHOT_COUNT);
  const originals = new Map(
    first.snapshots.map((snapshot) => {
      const patch = inRunDir(job.cfg, `dropped/${snapshot.file}`);
      return [patch, fs.readFileSync(patch)];
    }),
  );
  const next = openIn(job.cfg, path.dirname(job.origin));
  fs.writeFileSync(inRunDir(job.cfg, "job.json"), "new job status\n");
  const before = git(next.repo, ["status", "--porcelain"]);
  const lines = recoveryLines(next.cfg, ISSUE, next.branch).join("\n");
  assert.ok(lines.includes(TIMEOUT.reason));
  for (const snapshot of first.snapshots) {
    assert.ok(lines.includes(snapshot.file));
    assert.ok(lines.includes(snapshot.base));
    assert.ok(lines.includes(snapshot.kind));
  }
  assert.equal(git(next.repo, ["status", "--porcelain"]), before);
  assert.equal(headOf(next.repo), bases.repo);
  assert.deepEqual(recoveryLines(next.cfg, ISSUE, "different-assignment"), []);
  assert.deepEqual(
    recoveryLines({ ...next.cfg, repo: "another/repo" }, ISSUE, next.branch),
    [],
  );
  write(next.repo, "later.txt", "second attempt\n");
  await close(next, SECOND, TIMEOUT);
  for (const [patch, bytes] of originals) {
    assert.deepEqual(fs.readFileSync(patch), bytes);
  }
  const laterLines = recoveryLines(next.cfg, ISSUE, next.branch).join("\n");
  assert.ok(laterLines.includes(FIRST));
  assert.ok(laterLines.includes(SECOND));
  assert.equal(manifest(next, SECOND).snapshots.length, 1);
});

test("stale recovery keeps old bases visible without changing current heads, staged versions or working files", async () => {
  const job = openFresh();
  leaveChanges(job.repo, "README.md");
  leaveChanges(job.docs, "Home.md");
  await close(job, FIRST, TIMEOUT);
  const first = manifest(job, FIRST);
  const next = openIn(job.cfg, path.dirname(job.origin));
  const tracked = { repo: "README.md", docs: "Home.md" };
  const heads = new Map();
  for (const side of /** @type {const} */ (["repo", "docs"])) {
    write(next[side], tracked[side], "current committed work\n");
    git(next[side], ["commit", "-am", "Current work"], COMMIT_ENV);
    heads.set(side, headOf(next[side]));
    write(next[side], tracked[side], "current staged work\n");
    git(next[side], ["add", tracked[side]]);
    write(next[side], tracked[side], "current working work\n");
  }
  const lines = recoveryLines(next.cfg, ISSUE, next.branch).join("\n");
  for (const snapshot of first.snapshots) {
    assert.notEqual(heads.get(snapshot.checkout), snapshot.base);
    assert.ok(lines.includes(snapshot.base));
    assert.ok(lines.includes(snapshot.source));
  }
  for (const side of /** @type {const} */ (["repo", "docs"])) {
    assert.equal(headOf(next[side]), heads.get(side));
    assert.equal(
      git(next[side], ["show", `:${tracked[side]}`]),
      "current staged work",
    );
    assert.equal(
      fs.readFileSync(path.join(next[side], tracked[side]), "utf8"),
      "current working work\n",
    );
  }
});

test("failure to save durable recovery metadata retains original staged and working bytes in both checkouts", async () => {
  const job = openFresh();
  leaveChanges(job.repo, "README.md");
  leaveChanges(job.docs, "Home.md");
  const dir = inRunDir(job.cfg, "dropped");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${FIRST}.json`);
  fs.writeFileSync(file, "earlier evidence\n");
  await assert.rejects(close(job, FIRST, TIMEOUT));
  assert.equal(fs.readFileSync(file, "utf8"), "earlier evidence\n");
  for (const [checkout, tracked] of /** @type {const} */ ([
    [job.repo, "README.md"],
    [job.docs, "Home.md"],
  ])) {
    assert.equal(git(checkout, ["show", `:${tracked}`]), "staged");
    assert.equal(
      fs.readFileSync(path.join(checkout, tracked), "utf8"),
      "staged\nunstaged\n",
    );
  }
});
