// @ts-check
// Recovery through the real job teardown, with an isolated local Git origin.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  CHECKED_OUT_EXECUTABLE_MODE,
  COMMIT_ENV,
  close,
  inRunDir,
  KEY,
  leaveChanges,
  openFresh,
  REGULAR_EXECUTABLE_MODE,
} from "../job-checkout-dropped-test-kit.mjs";
import {
  git,
  headOf,
  ISSUE,
  root,
  write,
} from "../pipeline-commit-test-kit.mjs";

const { paths } = await import("../../src/config.ts");
const { openJobCheckout } = await import("../../src/job/checkout.ts");
/** @param {string} dir @returns {Buffer} */
function indexBytes(dir) {
  const index = git(dir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  return fs.readFileSync(index);
}

for (const failure of [
  "patch directory",
  "bundle directory",
  "existing bundle",
]) {
  test(`${failure} failure preserves the checkout, its exact index, modes and local commits`, async () => {
    const job = openFresh();
    write(job.repo, "README.md", "local commit\n");
    git(job.repo, ["commit", "-am", "Local recovery commit"], COMMIT_ENV);
    const head = headOf(job.repo);
    const left = leaveChanges(job.repo, "README.md");
    const index = indexBytes(job.repo);
    const runDir = paths.runDir(job.cfg, ISSUE);
    fs.mkdirSync(runDir, { recursive: true });
    let obstruction = path.join(runDir, "dropped");
    if (failure === "bundle directory") {
      obstruction = path.join(runDir, "recovery");
    } else if (failure === "existing bundle") {
      obstruction = path.join(runDir, "recovery");
      fs.mkdirSync(obstruction);
      obstruction = path.join(obstruction, `${KEY}-code.bundle`);
    }
    fs.writeFileSync(obstruction, "prior evidence\n");
    await assert.rejects(close(job, KEY));
    assert.equal(fs.existsSync(job.root), true);
    assert.equal(fs.readFileSync(obstruction, "utf8"), "prior evidence\n");
    assert.equal(headOf(job.repo), head);
    assert.deepEqual(indexBytes(job.repo), index);
    for (const [file, bytes] of left) {
      assert.deepEqual(fs.readFileSync(path.join(job.repo, file)), bytes);
    }
    assert.equal(
      fs.statSync(path.join(job.repo, "run.sh")).mode,
      REGULAR_EXECUTABLE_MODE,
    );
    assert.equal(
      fs.existsSync(paths.droppedPatch(job.cfg, ISSUE, KEY, "repo")),
      failure !== "patch directory",
    );
    assert.throws(() =>
      openJobCheckout(job.cfg, ISSUE, {
        stage: "implement",
        branch: job.branch,
      }),
    );
    assert.deepEqual(indexBytes(job.repo), index);
  });
}

test("independent bundle and patch recovery restores the exact local commit, rename, binary, symlink and executable mode", async () => {
  const job = openFresh();
  write(job.repo, "README.md", "local commit\n");
  git(job.repo, ["commit", "-am", "Local recovery base"], COMMIT_ENV);
  const local = headOf(job.repo);
  const files = leaveChanges(job.repo, "README.md");
  git(job.repo, ["mv", "README.md", "renamed.md"]);
  files.delete("README.md");
  files.set("renamed.md", Buffer.from("staged\nunstaged\n"));
  fs.symlinkSync("renamed.md", path.join(job.repo, "link.md"));
  await close(job, KEY);
  const bundle = inRunDir(job.cfg, `recovery/${KEY}-code.bundle`);
  const fresh = fs.mkdtempSync(path.join(root, "recovered-"));
  git(root, ["clone", bundle, fresh]);
  assert.equal(headOf(fresh), local);
  git(fresh, [
    "apply",
    "--index",
    paths.droppedPatch(job.cfg, ISSUE, KEY, "repo"),
  ]);
  for (const [file, bytes] of files) {
    assert.deepEqual(fs.readFileSync(path.join(fresh, file)), bytes, file);
  }
  assert.equal(fs.existsSync(path.join(fresh, "README.md")), false);
  assert.equal(
    fs.lstatSync(path.join(fresh, "link.md")).isSymbolicLink(),
    true,
  );
  assert.equal(fs.readlinkSync(path.join(fresh, "link.md")), "renamed.md");
  assert.equal(
    fs.statSync(path.join(fresh, "run.sh")).mode,
    CHECKED_OUT_EXECUTABLE_MODE,
  );
  assert.equal(fs.existsSync(job.root), false);
});
