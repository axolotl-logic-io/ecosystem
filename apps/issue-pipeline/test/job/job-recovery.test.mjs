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
} from "../job-checkout-dropped-test-kit.mjs";
import { git, headOf, ISSUE, write } from "../pipeline-commit-test-kit.mjs";

const { MANIFEST, recoveryLines } = await import(
  "../../src/job/dropped-patch.ts"
);
const FIRST = "review-20261019T191100000Z";
const SNAPSHOT_COUNT = 2;
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

test("the checkout's snapshots independently restore its staged and working versions on the recorded base", async () => {
  const job = openFresh();
  const base = headOf(job.repo);
  leaveChanges(job.repo, "README.md");
  await close(job, FIRST, TIMEOUT);
  const first = manifest(job, FIRST);
  assert.equal(first.snapshots.length, SNAPSHOT_COUNT);
  for (const snapshot of first.snapshots) {
    const patch = inRunDir(job.cfg, `dropped/${snapshot.file}`);
    assert.equal(snapshot.checkout, "repo");
    assert.equal(snapshot.base, base);
    assert.equal(snapshot.source, job.repo);
    const tracked = "README.md";
    const fresh = restored(job.origin, snapshot.base, patch);
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
  const base = headOf(job.repo);
  leaveChanges(job.repo, "README.md");
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
  assert.equal(headOf(next.repo), base);
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
  await close(job, FIRST, TIMEOUT);
  const first = manifest(job, FIRST);
  const next = openIn(job.cfg, path.dirname(job.origin));
  const tracked = "README.md";
  write(next.repo, tracked, "current committed work\n");
  git(next.repo, ["commit", "-am", "Current work"], COMMIT_ENV);
  const head = headOf(next.repo);
  write(next.repo, tracked, "current staged work\n");
  git(next.repo, ["add", tracked]);
  write(next.repo, tracked, "current working work\n");
  const lines = recoveryLines(next.cfg, ISSUE, next.branch).join("\n");
  for (const snapshot of first.snapshots) {
    assert.notEqual(head, snapshot.base);
    assert.ok(lines.includes(snapshot.base));
    assert.ok(lines.includes(snapshot.source));
  }
  assert.equal(headOf(next.repo), head);
  assert.equal(git(next.repo, ["show", `:${tracked}`]), "current staged work");
  assert.equal(
    fs.readFileSync(path.join(next.repo, tracked), "utf8"),
    "current working work\n",
  );
});

test("failure to save durable recovery metadata retains original staged and working bytes in the checkout", async () => {
  const job = openFresh();
  leaveChanges(job.repo, "README.md");
  const dir = inRunDir(job.cfg, "dropped");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${FIRST}.json`);
  fs.writeFileSync(file, "earlier evidence\n");
  await assert.rejects(close(job, FIRST, TIMEOUT));
  assert.equal(fs.readFileSync(file, "utf8"), "earlier evidence\n");
  assert.equal(git(job.repo, ["show", ":README.md"]), "staged");
  assert.equal(
    fs.readFileSync(path.join(job.repo, "README.md"), "utf8"),
    "staged\nunstaged\n",
  );
});

test("a Review manifest saved while the pipeline had a wiki still lists its repo/ and docs/ patches, without the wiki access", () => {
  const job = openFresh();
  const base = headOf(job.repo);
  const dropped = inRunDir(job.cfg, "dropped");
  fs.mkdirSync(dropped, { recursive: true });
  const snapshot = { source: "/old/job", kind: "working-tree", base };
  fs.writeFileSync(
    path.join(dropped, `${FIRST}.json`),
    JSON.stringify({
      version: 1,
      repo: job.cfg.repo,
      issue: ISSUE,
      branch: job.branch,
      job: FIRST,
      wikiAccess: "write",
      origin: TIMEOUT,
      snapshots: [
        { ...snapshot, file: `${FIRST}-repo.patch`, checkout: "repo" },
        { ...snapshot, file: `${FIRST}-docs.patch`, checkout: "docs" },
      ],
    }),
  );
  const lines = recoveryLines(job.cfg, ISSUE, job.branch).join("\n");
  assert.ok(lines.includes(`${FIRST}-repo.patch; checkout: repo/`));
  assert.ok(lines.includes(`${FIRST}-docs.patch; checkout: docs/`));
  assert.ok(!lines.includes("wiki access"));
});
