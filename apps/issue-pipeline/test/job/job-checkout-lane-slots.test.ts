// Real checkout removal and recovery decide when warm environments are free.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../../src/config.ts";
import {
  close,
  inRunDir,
  openFresh,
} from "../job-checkout-dropped-test-kit.ts";
import { git, ISSUE, write } from "../pipeline-commit-test-kit.ts";

const { paths, withCheckout }: typeof import("../../src/config.ts") =
  await import("../../src/config.ts");
const { setUpCheckout }: typeof import("../../src/checkouts.ts") = await import(
  "../../src/checkouts.ts"
);
const { openJobCheckout }: typeof import("../../src/job/checkout.ts") =
  await import("../../src/job/checkout.ts");
const {
  checkoutEnvironment,
  withCheckoutSlot,
}: typeof import("../../src/lane-slots.ts") = await import(
  "../../src/lane-slots.ts"
);
const { runChecks }: typeof import("../../src/ops/checks.ts") = await import(
  "../../src/ops/checks.ts"
);
const { head }: typeof import("../../src/git-state.ts") = await import(
  "../../src/git-state.ts"
);

function lease(cfg: Config, issue: number): string | undefined | null {
  return withCheckoutSlot(cfg, issue, () => {
    fs.mkdirSync(paths.worktree(cfg, issue), { recursive: true });
    return checkoutEnvironment(cfg, issue).get("ISSUE_PIPELINE_LANE_SLOT");
  });
}

const SETUP_INCOMPLETE = /setup is incomplete/u;
const NO_FREE_SLOT = /no free lane slot/u;
const PRESERVED_WORK = /preserved local work/u;
const RETAINED_WORK = /retained work/u;
const SETUP_FAILED = /lane setup failed/u;
const ORIGINAL_WORK = /original/u;
test("disposable stages release only after real removal and later stages can lease another slot", async () => {
  const opened = openFresh();
  const cfg = { ...opened.cfg, laneSlots: 2 };
  const job = { ...opened, cfg };
  const scoped = withCheckout(cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  assert.equal(lease(scoped, ISSUE), "1");
  write(job.repo, "saved.txt", "preserved local work\n");
  await close(job, "first-stage");
  assert.equal(fs.existsSync(job.root), false);
  const evidence = inRunDir(cfg, "dropped/first-stage-repo.patch");
  assert.match(fs.readFileSync(evidence, "utf8"), PRESERVED_WORK);
  assert.equal(lease(cfg, ISSUE + 1), "1");
  const next = openJobCheckout(cfg, ISSUE, {
    stage: "review",
    branch: job.branch,
  });
  const resumed = withCheckout(cfg, {
    issue: ISSUE,
    dir: next.repo,
    branch: job.branch,
  });
  assert.equal(lease(resumed, ISSUE), "2");
  await close({ ...job, ...next }, "next-stage");
  assert.equal(fs.existsSync(next.root), false);
  assert.match(fs.readFileSync(evidence, "utf8"), PRESERVED_WORK);
});

test("failed recovery preserves checkout ownership until successful recovery and removal", async () => {
  const opened = openFresh();
  const cfg = { ...opened.cfg, laneSlots: 1 };
  const job = { ...opened, cfg };
  const scoped = withCheckout(cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  lease(scoped, ISSUE);
  write(job.repo, "saved.txt", "retained work\n");
  const obstruction = path.join(paths.runDir(cfg, ISSUE), "dropped");
  fs.mkdirSync(path.dirname(obstruction), { recursive: true });
  fs.writeFileSync(obstruction, "prior evidence\n");
  await assert.rejects(close(job, "failed-stage"));
  assert.equal(
    fs.readFileSync(path.join(job.repo, "saved.txt"), "utf8"),
    "retained work\n",
  );
  assert.throws(() => lease(cfg, ISSUE + 1), NO_FREE_SLOT);
  assert.equal(
    checkoutEnvironment(scoped, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  fs.unlinkSync(obstruction);
  await close(job, "recovered-stage");
  assert.equal(fs.existsSync(job.root), false);
  assert.equal(lease(cfg, ISSUE + 1), "1");
  assert.match(
    fs.readFileSync(
      inRunDir(cfg, "dropped/recovered-stage-repo.patch"),
      "utf8",
    ),
    RETAINED_WORK,
  );
});

test("a failed setup keeps a real pre-created clone until a successful retry permits ordinary removal", async () => {
  const opened = openFresh();
  const cfg = {
    ...opened.cfg,
    laneSlots: 1,
    commands: { test: "true", setup: "printf 'original' > local-work; exit 2" },
  };
  const job = { ...opened, cfg };
  const scoped = withCheckout(cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  lease(scoped, ISSUE);
  assert.throws(
    () => setUpCheckout(scoped, ISSUE, job.repo, "setup.log"),
    SETUP_FAILED,
  );
  await assert.rejects(close(job, "setup-failed"), SETUP_INCOMPLETE);
  assert.equal(
    fs.readFileSync(path.join(job.repo, "local-work"), "utf8"),
    "original",
  );
  assert.throws(() => lease(cfg, ISSUE + 1), NO_FREE_SLOT);
  setUpCheckout(
    { ...scoped, commands: { test: "true", setup: "true" } },
    ISSUE,
    job.repo,
    "retry.log",
  );
  assert.equal(
    checkoutEnvironment(scoped, ISSUE).get("ISSUE_PIPELINE_LANE_SLOT"),
    "1",
  );
  await close(job, "setup-retried");
  assert.equal(fs.existsSync(job.root), false);
  assert.equal(lease(cfg, ISSUE + 1), "1");
  assert.match(
    fs.readFileSync(inRunDir(cfg, "dropped/setup-retried-repo.patch"), "utf8"),
    ORIGINAL_WORK,
  );
});

test("verification setup and tests share the issue slot in primary and secondary checkouts serially", async () => {
  const opened = openFresh();
  const cfg = {
    ...opened.cfg,
    laneSlots: 1,
    commands: {
      test: 'test "$(cat assigned-slot)" = "$ISSUE_PIPELINE_LANE_SLOT" && test "$ISSUE_PIPELINE_LANE_SLOT" = 1',
      setup: "printf '%s' \"$ISSUE_PIPELINE_LANE_SLOT\" > assigned-slot",
    },
  };
  const job = { ...opened, cfg };
  const scoped = withCheckout(cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  lease(scoped, ISSUE);
  const sha = head(job.repo);
  const primary = runChecks(scoped, ISSUE, { dir: job.repo, sha, changed: [] });
  assert.equal(primary.pass, true, JSON.stringify(primary));
  const secondary = path.join(job.root, "verification-copy");
  git(job.repo, ["worktree", "add", "--detach", secondary, sha]);
  const copy = runChecks(scoped, ISSUE, { dir: secondary, sha, changed: [] });
  assert.equal(copy.pass, true, JSON.stringify(copy));
  assert.equal(
    fs.readFileSync(path.join(secondary, "assigned-slot"), "utf8"),
    "1",
  );
  assert.throws(() => lease(cfg, ISSUE + 1), NO_FREE_SLOT);
  await close(job, "verified-stage");
});
