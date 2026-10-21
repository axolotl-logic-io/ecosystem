// The checks verify runs at one commit in one checkout: the configured
// commands (setup first, which stops the rest when it fails), whether each
// changed lockfile regenerates to itself, and the migrations when the change
// touches them. They leave the checkout's tracked files as they found them.

import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { matchAny } from "../globs.ts";
import { checkoutEnvironment } from "../lane-slots.ts";
import type { ShellResult } from "../process.ts";
import { run, shell } from "../process.ts";

// One check's outcome. `log` names the log of the command it ran, and `tail`
// ends that log, for failed checks only.
interface Check {
  id: string;
  pass: boolean;
  detail: string;
  log?: string;
  tail?: string;
}

// changedFiles is missing when setup failed and no other check ran.
interface VerifyReply {
  pass: boolean;
  headSha: string;
  changedFiles?: string[];
  checks: Check[];
}

type MigrationStep = "setup" | "up" | "down" | "upAgain";

const MS_PER_MINUTE = 60_000;
const SHORT_SHA_LENGTH = 8;
const MIGRATION_STEPS: readonly MigrationStep[] = [
  "setup",
  "up",
  "down",
  "upAgain",
];

const COMMAND = z.string().nullish();
const MIGRATIONS = z.looseObject({
  down: COMMAND,
  pathGlobs: z.array(z.string()).optional(),
  setup: COMMAND,
  up: COMMAND,
});
const SETTINGS = z.looseObject({
  commands: z.looseObject({
    lint: COMMAND,
    setup: COMMAND,
    teardown: COMMAND,
    test: z.string(),
    typecheck: COMMAND,
  }),
  commandTimeoutMinutes: z.number(),
  lockfiles: z
    .array(z.looseObject({ path: z.string(), regenerate: z.string() }))
    .nullish(),
  migrations: MIGRATIONS.nullish(),
});

type Settings = z.infer<typeof SETTINGS>;
type Migrations = z.infer<typeof MIGRATIONS>;

// One verify run: the checkout it runs in, the files its change touches, its
// logs' folder, and the checks so far.
interface Verification {
  dir: string;
  settings: Settings;
  changed: string[];
  checks: Check[];
  logDir: string;
  timeoutMs: number;
  env: ReadonlyMap<string, string>;
}

function present(command: string | null | undefined): command is string {
  return command !== undefined && command !== null && command !== "";
}

function logPath(v: Verification, name: string): string {
  return path.join(v.logDir, `${name}.log`);
}

function record(
  v: Verification,
  outcome: Pick<Check, "id" | "pass" | "detail">,
  result?: ShellResult,
): void {
  const check: Check = { ...outcome };
  if (result?.log !== undefined) {
    check.log = result.log;
  }
  if (!outcome.pass && result !== undefined) {
    check.tail = result.tail;
  }
  v.checks.push(check);
}

// Runs `command` in the worktree as check `id`, which passes when it exits 0.
function exitCheck(
  v: Verification,
  id: string,
  command: string,
  logName: string = id,
): boolean {
  const result = shell(command, v.dir, logPath(v, logName), {
    timeoutMs: v.timeoutMs,
    env: v.env,
  });
  const pass = result.code === 0;
  record(v, { id, pass, detail: `exit ${result.code}` }, result);
  return pass;
}

// Setup, then the test, lint and typecheck commands. False when setup fails.
function runCommands(v: Verification): boolean {
  const { setup, test, lint, typecheck } = v.settings.commands;
  if (present(setup) && !exitCheck(v, "setup", setup)) {
    return false;
  }
  const commands = new Map([
    ["test", test],
    ["lint", lint],
    ["typecheck", typecheck],
  ]);
  for (const [id, command] of commands) {
    if (present(command)) {
      exitCheck(v, id, command);
    }
  }
  return true;
}

// Each changed lockfile must regenerate to itself. The regenerated file is
// restored afterwards.
function checkLockfiles(v: Verification): void {
  const lockfiles = v.settings.lockfiles ?? [];
  for (const { path: file, regenerate } of lockfiles) {
    if (v.changed.includes(file)) {
      const log = logPath(v, `lockfile-${path.basename(file)}`);
      const result = shell(regenerate, v.dir, log, {
        timeoutMs: v.timeoutMs,
        env: v.env,
      });
      const diff = ["-C", v.dir, "diff", "--quiet", "--", file];
      const same = run("git", diff, { allowFail: true }).code === 0;
      run("git", ["-C", v.dir, "checkout", "--", file], { allowFail: true });
      const pass = result.code === 0 && same;
      let detail = "regenerated lockfile differs from the committed one";
      if (same) {
        detail = "regenerated lockfile matches";
      }
      record(v, { id: `lockfile:${file}`, pass, detail }, result);
    }
  }
}

// Up again runs the up command, and only after a down.
function migrationCommand(
  migrations: Migrations,
  step: MigrationStep,
): string | null | undefined {
  switch (step) {
    case "setup":
      return migrations.setup;
    case "up":
      return migrations.up;
    case "down":
      return migrations.down;
    case "upAgain":
      if (present(migrations.down)) {
        return migrations.up;
      }
      return undefined;
    default: {
      const unknown: never = step;
      return unknown;
    }
  }
}

// A change to the migrations runs each step until one fails.
function runMigrations(v: Verification): void {
  const { migrations } = v.settings;
  if (migrations === undefined || migrations === null) {
    return;
  }
  if (!v.changed.some((f) => matchAny(migrations.pathGlobs, f))) {
    return;
  }
  for (const step of MIGRATION_STEPS) {
    const command = migrationCommand(migrations, step);
    const id = `migration:${step}`;
    if (present(command) && !exitCheck(v, id, command, `migration-${step}`)) {
      return;
    }
  }
}

// The files changed from `from` to `sha` in the checkout at `dir`.
function changedFiles(dir: string, from: string, sha: string): string[] {
  return gitIn(dir, ["diff", "--name-only", `${from}..${sha}`])
    .split("\n")
    .filter((file) => file !== "");
}

// Runs every check at `sha`, checked out in `dir`, whose change touches
// `changed`, and leaves `dir`'s tracked files as it found them.
function runChecks(
  cfg: Config,
  n: number,
  checkout: { dir: string; sha: string; changed: string[] },
): VerifyReply {
  const settings = SETTINGS.parse(cfg);
  const { dir, sha, changed } = checkout;
  const v: Verification = {
    dir,
    changed,
    checks: [],
    logDir: path.join(
      paths.runDir(cfg, n),
      `verify-${sha.slice(0, SHORT_SHA_LENGTH)}`,
    ),
    settings,
    timeoutMs: settings.commandTimeoutMinutes * MS_PER_MINUTE,
    env: checkoutEnvironment(cfg, n),
  };
  if (!runCommands(v)) {
    return { pass: false, headSha: sha, checks: v.checks };
  }
  checkLockfiles(v);
  runMigrations(v);
  run("git", ["-C", dir, "checkout", "--", "."], { allowFail: true });
  const pass = v.checks.every((check) => check.pass);
  return { pass, headSha: sha, changedFiles: changed, checks: v.checks };
}

export type { Check, VerifyReply };
export { changedFiles, present, runChecks, SETTINGS };
