// @ts-check
// Native Git alone follows the padded URL. The guarded tests must refuse it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { BASE, git, world } from "./explicit-target-world-test-kit.mjs";

test("native Git can move the distinct trailing-space bare destination while leaving intended origin unchanged", () => {
  const w = world({ fastForward: true });
  const alternate = `${w.origin} `;
  git(w.place, ["clone", "-q", "--mirror", w.origin, alternate]);
  git(w.wt, ["config", "remote.origin.pushurl", alternate]);
  assert.notEqual(fs.realpathSync(w.origin), fs.realpathSync(alternate));
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
  const effective = execFileSync(
    "git",
    ["-C", w.wt, "remote", "get-url", "--push", "--all", "origin"],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(effective, `${alternate}\n`);
  // The old trim-based comparison loses the distinction, before any race.
  assert.equal(effective.trim(), w.origin);
  git(w.wt, [
    "push",
    "--porcelain",
    `--force-with-lease=refs/heads/${BASE}:${w.base}`,
    "origin",
    `${w.head}:refs/heads/${BASE}`,
  ]);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(git(alternate, ["rev-parse", BASE]), w.head);
});
