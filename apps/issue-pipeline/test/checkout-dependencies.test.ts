// A surviving verification worktree must keep its backing primary clone usable.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import type { Opened } from "./job-checkout-dropped-test-kit.ts";
import { close, openFresh } from "./job-checkout-dropped-test-kit.ts";
import { git } from "./pipeline-commit-test-kit.ts";

const { paths, withCheckout }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { openJobCheckout }: typeof import("../src/job/checkout.ts") =
  await import("../src/job/checkout.ts");
const {
  releaseCheckoutSlot,
  withCheckoutSlot,
}: typeof import("../src/lane-slots.ts") = await import("../src/lane-slots.ts");
const DEPENDENT = /depends on Git metadata/u;
const AMBIGUOUS = /cannot establish Git metadata independence/u;
const NO_CAPACITY = /no free lane slot/u;
const ISSUE = 7;

function configuredPrimary(): Opened {
  const opened = openFresh();
  const job = { ...opened, cfg: { ...opened.cfg, laneSlots: 1 } };
  register(job);
  return job;
}

function register(job: Opened): void {
  const scoped = withCheckout(job.cfg, {
    issue: ISSUE,
    dir: job.repo,
    branch: job.branch,
  });
  withCheckoutSlot(scoped, ISSUE, () => true);
}

function secondary(cfg: Config, primary: { repo: string }): string {
  const dir = path.join(paths.runDir(cfg, ISSUE), "retained-verification");
  const scoped = withCheckout(cfg, {
    issue: ISSUE,
    dir,
    branch: paths.branch(cfg, ISSUE),
  });
  withCheckoutSlot(scoped, ISSUE, () =>
    git(primary.repo, ["worktree", "add", "--detach", dir, "HEAD"]),
  );
  return dir;
}

test("failed secondary removal preserves primary Git metadata, usable secondary and its lease", async () => {
  const primary = configuredPrimary();
  const { cfg } = primary;
  const dir = secondary(cfg, primary);
  fs.writeFileSync(path.join(dir, "retained-work"), "recover this\n");
  assert.throws(() => git(primary.repo, ["worktree", "remove", dir]));
  const before = git(dir, ["rev-parse", "HEAD"]);
  await assert.rejects(close(primary, "secondary-retained"), DEPENDENT);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
  assert.equal(fs.existsSync(path.join(primary.repo, ".git")), true);
  assert.throws(() => withCheckoutSlot(cfg, 2, () => true), NO_CAPACITY);
  git(primary.repo, ["worktree", "remove", "--force", dir]);
  releaseCheckoutSlot(cfg);
  await close(primary, "secondary-retained");
  assert.equal(fs.existsSync(primary.repo), false);
  assert.equal(
    withCheckoutSlot(cfg, 2, () => true),
    true,
  );
});

test("independent stage clones remain independently removable while the other holds its slot", async () => {
  const first = configuredPrimary();
  const { cfg } = first;
  const next = openJobCheckout(cfg, ISSUE, {
    stage: "review",
    branch: first.branch,
  });
  const other = { ...first, ...next };
  register(other);
  await close(first, "independent-first");
  assert.equal(fs.existsSync(first.repo), false);
  assert.ok(git(other.repo, ["rev-parse", "HEAD"]));
  assert.throws(() => withCheckoutSlot(cfg, 2, () => true), NO_CAPACITY);
  await close(other, "independent-last");
  assert.equal(
    withCheckoutSlot(cfg, 2, () => true),
    true,
  );
});

test("ambiguous registered secondary metadata fails closed before primary reset or removal", async () => {
  const primary = configuredPrimary();
  const { cfg } = primary;
  const dir = secondary(cfg, primary);
  const metadata = path.join(dir, ".git");
  const original = fs.readFileSync(metadata);
  fs.writeFileSync(metadata, "invalid git metadata\n");
  await assert.rejects(close(primary, "secondary-retained"), AMBIGUOUS);
  assert.equal(fs.existsSync(path.join(primary.repo, ".git")), true);
  fs.writeFileSync(metadata, original);
  git(primary.repo, ["worktree", "remove", "--force", dir]);
  releaseCheckoutSlot(cfg);
  await close(primary, "secondary-retained");
});
