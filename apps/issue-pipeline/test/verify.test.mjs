// @ts-check
// The verify op: its reply, check by check, for setup, the configured
// commands, lockfiles and migrations, against local git repos. Every case
// leaves the worktree clean and no temp worktree behind. Verify no longer
// runs the new tests against the unfixed code (fails-before-fix): the
// reviewer judges the tests (src/config-legacy.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { setEnv } from "./ops-run-test-kit.mjs";
import {
  ask,
  askRaw,
  CLEAN,
  verifyKit,
  writeConfig,
} from "./verify-test-kit.mjs";

/** @import { Files } from "./verify-test-kit.mjs" */

const root = fs.mkdtempSync("/tmp/issue-pipeline-verify-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
setEnv("ISSUE_PIPELINE_ROOT", root);
const kit = verifyKit(root);
const FIXED = { "src/a.js": "fixed\n" };
const LOCKFILE = "package-lock.json";
// Verify's reply, read as far as the tests take it apart.
const VERIFY_REPLY = z.looseObject({
  pass: z.boolean(),
  checks: z.array(z.unknown()),
});

// Runs verify on a branch with `files` changed, and returns the reply, the
// branch's head, where verify keeps its logs, what it left behind and the
// worktree it ran in.
/** @typedef {{ raw: string, reply: z.infer<typeof VERIFY_REPLY>, sha: string, log: (id: string) => string, leftovers: { status: string, temps: string[] }, worktree: string }} VerifyCase */
/** @param {Files} files @param {object} commands @param {object} [extra] @returns {VerifyCase} */
function verifyCase(files, commands, extra = {}) {
  const { n, sha } = kit.branch(files);
  const config = writeConfig(root, n, commands, extra);
  const raw = askRaw(root, { op: "verify", config, number: n });
  const logs = kit.logs(n, sha);
  /** @param {string} id @returns {string} */
  function log(id) {
    return path.join(logs, `${id}.log`);
  }
  const leftovers = kit.leftovers(n);
  const worktree = kit.worktree(n);
  return {
    raw,
    reply: VERIFY_REPLY.parse(JSON.parse(raw)),
    sha,
    log,
    leftovers,
    worktree,
  };
}

/** @param {string} id @param {string} log @returns {object} */
function passed(id, log) {
  return { id, pass: true, detail: "exit 0", log };
}

test("a failing setup stops verify with only the setup check", () => {
  const { reply, sha, log, leftovers } = verifyCase(FIXED, { setup: "exit 2" });
  assert.deepEqual(reply, {
    ok: true,
    op: "verify",
    posted: 0,
    commentIds: [],
    pass: false,
    headSha: sha,
    checks: [
      {
        id: "setup",
        pass: false,
        detail: "exit 2",
        log: log("setup"),
        tail: "",
      },
    ],
  });
  assert.deepEqual(leftovers, CLEAN);
});

test("each command's check gives its exit code, its log and, when it fails, its tail", () => {
  const commands = {
    setup: "true",
    test: "echo ran",
    lint: "echo bad; exit 1",
    typecheck: "exit 3",
  };
  const { raw, sha, log, leftovers } = verifyCase(FIXED, commands);
  const want = {
    ok: true,
    op: "verify",
    posted: 0,
    commentIds: [],
    pass: false,
    headSha: sha,
    changedFiles: ["src/a.js"],
    checks: [
      passed("setup", log("setup")),
      passed("test", log("test")),
      {
        id: "lint",
        pass: false,
        detail: "exit 1",
        log: log("lint"),
        tail: "bad",
      },
      {
        id: "typecheck",
        pass: false,
        detail: "exit 3",
        log: log("typecheck"),
        tail: "",
      },
    ],
  };
  // The reply is one JSON line.
  assert.equal(raw.indexOf("\n"), raw.length - 1);
  assert.deepEqual(JSON.parse(raw), want);
  assert.deepEqual(leftovers, CLEAN);
});

test("a command that edits a tracked file has the edit undone", () => {
  const commands = { lint: "echo x >> src/a.js" };
  const extra = { requireNewTests: false };
  const { reply, log, leftovers, worktree } = verifyCase(
    FIXED,
    commands,
    extra,
  );
  assert.equal(reply.pass, true);
  assert.deepEqual(reply.checks, [
    passed("test", log("test")),
    passed("lint", log("lint")),
  ]);
  assert.deepEqual(leftovers, CLEAN);
  const text = fs.readFileSync(path.join(worktree, "src/a.js"), "utf8");
  assert.equal(text, FIXED["src/a.js"]);
});

test("a regenerated lockfile that matches passes, and the worktree stays clean", () => {
  const lockfiles = [{ path: LOCKFILE, regenerate: "true" }];
  const files = { [LOCKFILE]: "{}\n" };
  const { reply, sha, log, leftovers } = verifyCase(
    files,
    {},
    { lockfiles, requireNewTests: false },
  );
  assert.deepEqual(reply, {
    ok: true,
    op: "verify",
    posted: 0,
    commentIds: [],
    pass: true,
    headSha: sha,
    changedFiles: [LOCKFILE],
    checks: [
      passed("test", log("test")),
      {
        id: `lockfile:${LOCKFILE}`,
        pass: true,
        detail: "regenerated lockfile matches",
        log: log(`lockfile-${LOCKFILE}`),
      },
    ],
  });
  assert.deepEqual(leftovers, CLEAN);
});

test("a regenerated lockfile that differs fails, and is restored", () => {
  const lockfiles = [
    { path: LOCKFILE, regenerate: `echo '{"v":2}' > ${LOCKFILE}` },
  ];
  const files = { [LOCKFILE]: "{}\n" };
  const { reply, sha, log, leftovers } = verifyCase(
    files,
    {},
    { lockfiles, requireNewTests: false },
  );
  assert.deepEqual(reply, {
    ok: true,
    op: "verify",
    posted: 0,
    commentIds: [],
    pass: false,
    headSha: sha,
    changedFiles: [LOCKFILE],
    checks: [
      passed("test", log("test")),
      {
        id: `lockfile:${LOCKFILE}`,
        pass: false,
        detail: "regenerated lockfile differs from the committed one",
        log: log(`lockfile-${LOCKFILE}`),
        tail: "",
      },
    ],
  });
  assert.deepEqual(leftovers, CLEAN);
});

const MIGRATION = { "migrations/1.sql": "create table t (x int);\n" };

// Verify's reply on a change to a migration, with the migration checks
// apart, and what the reply should hold besides them.
/** @param {object} migrations @returns {{ got: object, want: object, log: (id: string) => string }} */
function migrationCase(migrations) {
  const { reply, sha, log, leftovers } = verifyCase(
    MIGRATION,
    {},
    { migrations: { pathGlobs: ["migrations/**"], ...migrations } },
  );
  const { checks, ...rest } = reply;
  const [testCheck, ...steps] = checks;
  const got = {
    ...rest,
    firstChecks: [testCheck],
    leftovers,
    steps,
  };
  const want = {
    ok: true,
    op: "verify",
    posted: 0,
    commentIds: [],
    headSha: sha,
    changedFiles: ["migrations/1.sql"],
    firstChecks: [passed("test", log("test"))],
    leftovers: CLEAN,
  };
  return { got, want, log };
}

test("a changed migration runs setup, up, down and up again", () => {
  const { got, want, log } = migrationCase({
    setup: "true",
    up: "true",
    down: "true",
  });
  const steps = ["setup", "up", "down", "upAgain"].map((step) =>
    passed(`migration:${step}`, log(`migration-${step}`)),
  );
  assert.deepEqual(got, { ...want, pass: true, steps });
});

test("the first failing migration step stops the run", () => {
  const { got, want, log } = migrationCase({
    setup: "true",
    up: "false",
    down: "true",
  });
  const steps = [
    passed("migration:setup", log("migration-setup")),
    {
      id: "migration:up",
      pass: false,
      detail: "exit 1",
      log: log("migration-up"),
      tail: "",
    },
  ];
  assert.deepEqual(got, { ...want, pass: false, steps });
});

test("an empty migration step, and up again without a down, are skipped", () => {
  const { got, want, log } = migrationCase({ setup: "", up: "true" });
  assert.deepEqual(got, {
    ...want,
    pass: true,
    steps: [passed("migration:up", log("migration-up"))],
  });
});

test("verify on a dirty worktree fails without running a check", () => {
  const { n } = kit.branch(FIXED);
  fs.writeFileSync(path.join(kit.worktree(n), "src/a.js"), "dirty\n");
  const reply = ask(root, {
    op: "verify",
    config: writeConfig(root, n, {}),
    number: n,
  });
  assert.deepEqual(reply, {
    ok: false,
    error: "worktree has uncommitted changes:\nM src/a.js",
  });
});
