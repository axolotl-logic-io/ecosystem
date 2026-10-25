// Removing setup is not proof that a failed or interrupted checkout is ready.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { config, occupy } from "./lane-slots-test-kit.ts";

const { paths }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { setUpCheckout }: typeof import("../src/checkouts.ts") = await import(
  "../src/checkouts.ts"
);
const { gitIn, head }: typeof import("../src/git-state.ts") = await import(
  "../src/git-state.ts"
);
const {
  assertCheckoutReadyForRemoval,
  withCheckoutSetup,
}: typeof import("../src/lane-slots.ts") = await import("../src/lane-slots.ts");
const { runChecks }: typeof import("../src/ops/checks.ts") = await import(
  "../src/ops/checks.ts"
);
const { OpsError }: typeof import("../src/ops-error.ts") = await import(
  "../src/ops-error.ts"
);

const INCOMPLETE = /setup is incomplete/u;
const FAILED_OR_INTERRUPTED = /lane setup failed|synthetic interruption/u;
const ABSENT_SETUPS = [
  { name: "omitted", commands: {} },
  { name: "null", commands: { setup: null } },
  { name: "empty", commands: { setup: "" } },
];
const ENTRY_POINTS: {
  name: string;
  run: (cfg: Config, dir: string, sha: string) => unknown;
}[] = [
  {
    name: "claim setup",
    run: (cfg: Config, dir: string) =>
      setUpCheckout(cfg, 1, dir, "absent-setup.log"),
  },
  {
    name: "deterministic checks",
    run: (cfg: Config, dir: string, sha: string) =>
      runChecks(cfg, 1, { dir, sha, changed: [] }),
  },
];

function fixture(commands: object): {
  cfg: Config;
  dir: string;
  alias: string;
  sha: string;
  marker: string;
} {
  const cfg = config({
    laneSlots: 1,
    commands: { test: "printf ran > .git/test-marker", ...commands },
  });
  occupy(cfg, 1);
  const dir = paths.worktree(cfg, 1);
  gitIn(dir, ["init", "-q"]);
  gitIn(dir, [
    "-c",
    "user.name=lane test",
    "-c",
    "user.email=lane@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const alias = `${dir}-alias`;
  fs.symlinkSync(dir, alias, "dir");
  return {
    cfg,
    dir,
    alias,
    sha: head(dir),
    marker: path.join(dir, ".git/test-marker"),
  };
}

function isPendingReadiness(error: unknown): boolean {
  return error instanceof OpsError && INCOMPLETE.test(error.message);
}

for (const absence of ABSENT_SETUPS) {
  for (const interrupted of [false, true]) {
    for (const entry of ENTRY_POINTS) {
      test(`${entry.name} refuses ${absence.name} setup after interrupted=${String(interrupted)} pending setup`, () => {
        const { cfg, dir, alias, sha, marker } = fixture(absence.commands);
        assert.throws(
          () =>
            withCheckoutSetup(cfg, 1, dir, () => {
              if (interrupted) {
                throw new Error("synthetic interruption");
              }
              return { code: 2, log: "synthetic-setup.log", tail: "failed" };
            }),
          FAILED_OR_INTERRUPTED,
        );
        assert.throws(
          () => assertCheckoutReadyForRemoval(cfg, 1, dir),
          INCOMPLETE,
        );
        assert.throws(() => entry.run(cfg, dir, sha), isPendingReadiness);
        assert.throws(() => entry.run(cfg, alias, sha), isPendingReadiness);
        assert.equal(fs.existsSync(marker), false);
        assert.throws(
          () => assertCheckoutReadyForRemoval(cfg, 1, dir),
          INCOMPLETE,
        );
        const retry = { ...cfg, commands: { ...cfg.commands, setup: "true" } };
        setUpCheckout(retry, 1, alias, "successful-retry.log");
        assert.doesNotThrow(() => assertCheckoutReadyForRemoval(cfg, 1, dir));
        assert.doesNotThrow(() =>
          setUpCheckout(cfg, 1, dir, "absent-after-retry.log"),
        );
        assert.equal(runChecks(cfg, 1, { dir, sha, changed: [] }).pass, true);
        assert.equal(fs.readFileSync(marker, "utf8"), "ran");
      });
    }
  }
  test(`never-configured ${absence.name} setup permits claim startup and deterministic checks`, () => {
    const { cfg, dir, sha, marker } = fixture(absence.commands);
    assert.doesNotThrow(() =>
      setUpCheckout(cfg, 1, dir, "never-configured.log"),
    );
    assert.equal(runChecks(cfg, 1, { dir, sha, changed: [] }).pass, true);
    assert.equal(fs.readFileSync(marker, "utf8"), "ran");
    assert.doesNotThrow(() => assertCheckoutReadyForRemoval(cfg, 1, dir));
  });
  test(`no-slot legacy ${absence.name} setup and checks ignore lane readiness`, () => {
    const { cfg, dir, sha, marker } = fixture(absence.commands);
    assert.throws(
      () =>
        withCheckoutSetup(cfg, 1, dir, () => ({
          code: 2,
          log: "synthetic",
          tail: "",
        })),
      FAILED_OR_INTERRUPTED,
    );
    const legacy = { ...cfg, laneSlots: undefined };
    assert.doesNotThrow(() => setUpCheckout(legacy, 1, dir, "legacy.log"));
    assert.equal(runChecks(legacy, 1, { dir, sha, changed: [] }).pass, true);
    assert.equal(fs.readFileSync(marker, "utf8"), "ran");
  });
}
