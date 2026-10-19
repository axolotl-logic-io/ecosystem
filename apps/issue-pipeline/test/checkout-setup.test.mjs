// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sql } from "./checkout-database-test-kit.mjs";
import {
  BASE_CONTENT,
  ENV_FILE,
  EXAMPLE,
  git,
  HEAD_CONTENT,
  prompts,
  roleJob,
  world,
} from "./checkout-setup-test-kit.mjs";

const { runChecks } = await import("../src/ops/checks.ts");
const FIRST_ISSUE = 7;
const STALE_PUBLIC_MODE = 0o644;
const SECOND_ISSUE = 8;
const SETUP_FAILED = /Configured setup FAILED/u;
const EXIT_23 = /exit 23/u;
const NO_SETUP = /setup: not configured/u;
const SYMLINK_ERROR = /ELOOP|Too many levels of symbolic links/u;

/** @type {import("../src/stages.ts").Stage[]} */
const STAGES = ["author", "implement", "review", "merge"];
for (const stage of STAGES) {
  test(`${stage} finishes setup before its model and supplies a guarded real-database test environment`, async () => {
    const w = world();
    const job = await roleJob(w, stage);
    // Existing permissions must be tightened, not just new files created safely.
    fs.writeFileSync(path.join(job.dirs.repo, ENV_FILE), "stale fixture", {
      mode: STALE_PUBLIC_MODE,
    });
    // A dirty example must never replace the checked-out committed source.
    fs.writeFileSync(path.join(job.dirs.repo, EXAMPLE), "FIXTURE_TEST=dirty\n");
    const result = await job.run();
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(
      fs.readFileSync(path.join(job.dirs.repo, ENV_FILE), "utf8"),
      HEAD_CONTENT,
    );
    assert.notEqual(HEAD_CONTENT, BASE_CONTENT);
    const files = fs.readdirSync(job.runDir);
    const log = files.find(
      (file) => file.startsWith(`setup-${stage}-`) && file.endsWith(".log"),
    );
    assert.ok(log);
    assert.ok(
      fs
        .readFileSync(path.join(job.runDir, log), "utf8")
        .includes("setup finished"),
    );
    const record = path.join(job.runDir, log.replace(".log", ".json"));
    assert.ok(fs.readFileSync(record, "utf8").includes('"pass":true'));
    const context = prompts(w);
    assert.ok(context.includes("Configured setup succeeded"));
    assert.ok(context.includes(record));
    assert.ok(context.includes("guardedTest"));
    assert.ok(context.includes("passed"));
  });
}

test("role and configured verification at the same HEAD provision identical files and share only that issue's database", async () => {
  const w = world();
  const job = await roleJob(w, "implement");
  // This is unrelated non-secret fixture data, never a source of provisioning.
  fs.writeFileSync(
    path.join(job.dirs.repo, ".env"),
    "UNRELATED_FIXTURE=not-the-example\n",
  );
  const result = await job.run();
  assert.ok(result.ok, JSON.stringify(result));
  const verification = path.join(w.tmp, "verification");
  git(w.tmp, ["clone", "--quiet", job.dirs.repo, verification]);
  const sha = git(verification, ["rev-parse", "HEAD"]);
  const checked = runChecks(w.cfg, FIRST_ISSUE, {
    dir: verification,
    sha,
    changed: [],
  });
  assert.ok(checked.pass, JSON.stringify(checked));
  assert.deepEqual(
    fs.readFileSync(path.join(verification, ENV_FILE)),
    fs.readFileSync(path.join(job.dirs.repo, ENV_FILE)),
  );
  assert.equal(
    sql(
      path.join(job.runDir, "test.sqlite"),
      "SELECT source FROM writes ORDER BY source",
    ),
    "role\nverification",
  );
});

test("a symlinked destination fails setup without touching the target and the failure reaches the role", async () => {
  const w = world();
  const job = await roleJob(w, "implement");
  const target = path.join(w.tmp, "untouched.txt");
  fs.writeFileSync(target, "untouched fixture\n");
  fs.symlinkSync(target, path.join(job.dirs.repo, ENV_FILE));
  const result = await job.run({ probe: false });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(fs.readFileSync(target, "utf8"), "untouched fixture\n");
  const log = path.join(job.runDir, "setup-implement-implementor-1.log");
  assert.match(fs.readFileSync(log, "utf8"), SYMLINK_ERROR);
  const context = prompts(w);
  assert.match(context, SETUP_FAILED);
  assert.ok(context.includes(log));
  assert.ok(context.includes("not successfully prepared"));
  assert.equal(context.includes("Configured setup succeeded"), false);
});

test("a nonzero setup result and its log are explicitly given to the session", async () => {
  const w = world("printf 'fixture setup failed'; exit 23");
  const job = await roleJob(w, "author");
  const result = await job.run({ probe: false });
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(prompts(w), SETUP_FAILED);
  assert.match(prompts(w), EXIT_23);
  const record = fs.readFileSync(
    path.join(job.runDir, "setup-author-author-1.json"),
    "utf8",
  );
  assert.ok(record.includes('"code":23'));
  assert.ok(record.includes('"pass":false'));
  assert.ok(
    fs
      .readFileSync(path.join(job.runDir, "setup-author-author-1.log"), "utf8")
      .includes("fixture setup failed"),
  );
});

test("no configured setup starts a session without creating app environment files or database resources", async () => {
  const w = world(null);
  const job = await roleJob(w, "author");
  const result = await job.run({ probe: false });
  assert.ok(result.ok, JSON.stringify(result));
  assert.match(prompts(w), NO_SETUP);
  assert.equal(fs.existsSync(path.join(job.dirs.repo, ENV_FILE)), false);
  assert.equal(fs.existsSync(path.join(job.runDir, "test.sqlite")), false);
  assert.equal(
    fs.readdirSync(job.runDir).some((file) => file.startsWith("setup-")),
    false,
  );
});

test("different issues' live role checkouts and verification never see each other's database writes", async () => {
  const w = world();
  const first = await roleJob(w, "implement", FIRST_ISSUE);
  const second = await roleJob(w, "review", SECOND_ISSUE);
  // Both issue checkouts remain live, without tearing down either resource.
  const sessions = await Promise.all([first.run(), second.run()]);
  assert.ok(
    sessions.every((result) => result.ok),
    JSON.stringify(sessions),
  );
  const databases = [first, second].map((job) =>
    fs.readFileSync(path.join(job.dirs.repo, "database-path.txt"), "utf8"),
  );
  assert.notEqual(databases[0], databases[1]);
  for (const { issue, job } of [
    { issue: FIRST_ISSUE, job: first },
    { issue: SECOND_ISSUE, job: second },
  ]) {
    // Configured checks repeat setup and run the same guarded test on each
    // issue. An isolation regression makes the fixture detect foreign rows.
    const sha = git(job.dirs.repo, ["rev-parse", "HEAD"]);
    const verified = runChecks(w.cfg, issue, {
      dir: job.dirs.repo,
      sha,
      changed: [],
    });
    assert.ok(verified.pass, JSON.stringify(verified));
  }
});

test("a later merge session prepares its newly selected HEAD rather than retaining a stale environment", async () => {
  const w = world();
  const job = await roleJob(w, "merge");
  assert.ok((await job.run()).ok);
  const next = "FIXTURE_TEST=merged-result\n";
  fs.writeFileSync(path.join(job.dirs.repo, EXAMPLE), next);
  git(job.dirs.repo, ["add", EXAMPLE]);
  git(job.dirs.repo, ["commit", "--quiet", "-m", "selected merged head"]);
  assert.ok((await job.run({ phase: "security-review" })).ok);
  assert.equal(
    fs.readFileSync(path.join(job.dirs.repo, ENV_FILE), "utf8"),
    next,
  );
  assert.ok(
    fs.existsSync(path.join(job.runDir, "setup-merge-reviewer-2.json")),
  );
});
