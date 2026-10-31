import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  type GitAccess,
  openBaseCheckout,
  openJobCheckout,
} from "../../src/checkout.ts";
import { run } from "../../src/command.ts";
import { closeJobCheckout } from "../../src/job/checkout-close.ts";
import { pinPage } from "../../src/job/prompts.ts";
import { readTrustedProjectSettings } from "../../src/project-policy.ts";
import { publishCheckout } from "../../src/publish-checkout.ts";

const temporaryRoots: string[] = [];
afterEach((): void => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const RETAINED = /preserve it for operator recovery/u;
const STOPPED = /stopped/u;
const DIRTY = /uncommitted/u;
const WRONG_ORIGIN = /repository origin/u;
const PLAIN_FILE = /plain file/u;

interface Fixture {
  root: string;
  origin: string;
  head: string;
  access: GitAccess;
  source: { mirror: string; url: string; base: string };
}
function git(dir: string, ...args: string[]): string {
  return run("git", ["-C", dir, ...args], {
    cwd: dir,
    timeoutMs: 10_000,
  }).stdout.trim();
}
function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-runtime-"));
  temporaryRoots.push(root);
  const origin = path.join(root, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.name", "Runtime test");
  git(origin, "config", "user.email", "runtime@example.test");
  fs.writeFileSync(path.join(origin, "code.txt"), "original\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "Initial");
  return {
    root,
    origin,
    head: git(origin, "rev-parse", "HEAD"),
    source: {
      mirror: path.join(root, "mirror.git"),
      url: origin,
      base: "main",
    },
    access: {
      run: (args: readonly string[]): ReturnType<typeof run> =>
        run("git", args, { cwd: root, timeoutMs: 10_000 }),
      withMirrorLock: <T>(operation: () => T): T => operation(),
    },
  };
}
function writable(world: Fixture): ReturnType<typeof openJobCheckout> {
  return openJobCheckout(
    {
      ...world.source,
      root: path.join(world.root, "job"),
      repo: path.join(world.root, "job", "repo"),
      branch: "work",
      identity: { name: "Writer", email: "writer@example.test" },
    },
    world.access,
  );
}
function commit(repo: string): void {
  git(repo, "add", ".");
  run("git", ["-C", repo, "commit", "-m", "Local work"], {
    cwd: repo,
    env: new Map([["ISSUE_PIPELINE_COMMIT", "1"]]),
    timeoutMs: 10_000,
  });
}

test("checkout capabilities pin the base and preserve an existing writable checkout", (): void => {
  const world = fixture();
  const read = path.join(world.root, "read");
  assert.equal(openBaseCheckout(world.source, read, world.access), world.head);
  assert.equal(git(read, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  const job = writable(world);
  assert.equal(git(job.repo, "config", "user.email"), "writer@example.test");
  fs.writeFileSync(path.join(job.repo, "retained.txt"), "retain this\n");
  assert.throws(() => writable(world), RETAINED);
  assert.equal(
    fs.readFileSync(path.join(job.repo, "retained.txt"), "utf8"),
    "retain this\n",
  );
  const refused = run(
    "git",
    ["-C", job.repo, "commit", "--allow-empty", "-m", "Unscoped"],
    { cwd: job.repo, allowFail: true },
  );
  assert.notEqual(refused.code, 0);
});

test("cleanup saves divergent staged bytes, working bytes and local history before removal", async (): Promise<void> => {
  const world = fixture();
  const job = writable(world);
  fs.writeFileSync(path.join(job.repo, "local.txt"), "committed locally\n");
  commit(job.repo);
  const localHead = git(job.repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(job.repo, "code.txt"), "staged\n");
  git(job.repo, "add", "code.txt");
  fs.writeFileSync(path.join(job.repo, "code.txt"), "working\n");
  fs.writeFileSync(path.join(job.repo, "new.txt"), "untracked\n");
  const artifacts = path.join(world.root, "artifacts");
  const dropped = await closeJobCheckout(
    { artifacts, repository: "owner/repo", issue: 1 },
    {
      ...job,
      key: "attempt",
      recovery: {
        stage: "implement",
        outcome: "failed",
        reason: "interrupted",
      },
    },
    null,
    world.access,
  );
  assert.equal(fs.existsSync(job.root), false);
  assert.equal(dropped.patches.length, 2);
  const restore = path.join(world.root, "restore");
  run(
    "git",
    ["clone", path.join(artifacts, "recovery", "attempt-code.bundle"), restore],
    { cwd: world.root, timeoutMs: 10_000 },
  );
  assert.equal(git(restore, "rev-parse", "HEAD"), localHead);
  assert.equal(
    fs.readFileSync(path.join(restore, "local.txt"), "utf8"),
    "committed locally\n",
  );
  const indexPatch = dropped.patches.find((file: string): boolean =>
    file.endsWith(".index.patch"),
  );
  const workingPatch = dropped.patches.find(
    (file: string): boolean => !file.endsWith(".index.patch"),
  );
  assert.ok(indexPatch);
  assert.ok(workingPatch);
  git(restore, "apply", "--index", path.join(artifacts, indexPatch));
  assert.equal(
    fs.readFileSync(path.join(restore, "code.txt"), "utf8"),
    "staged\n",
  );
  git(restore, "reset", "--hard", localHead);
  git(restore, "apply", "--index", path.join(artifacts, workingPatch));
  assert.equal(
    fs.readFileSync(path.join(restore, "code.txt"), "utf8"),
    "working\n",
  );
  assert.equal(
    fs.readFileSync(path.join(restore, "new.txt"), "utf8"),
    "untracked\n",
  );
});

test("failed recovery preparation retains the exact checkout and index", async (): Promise<void> => {
  const world = fixture();
  const job = writable(world);
  fs.writeFileSync(path.join(job.repo, "code.txt"), "staged\n");
  git(job.repo, "add", ".");
  fs.writeFileSync(path.join(job.repo, "code.txt"), "working\n");
  const artifacts = path.join(world.root, "artifacts");
  fs.mkdirSync(path.join(artifacts, "dropped"), { recursive: true });
  fs.writeFileSync(
    path.join(artifacts, "dropped", "attempt-repo.patch.index.patch"),
    "prior evidence",
  );
  await assert.rejects(
    closeJobCheckout(
      { artifacts, repository: "owner/repo", issue: 1 },
      { ...job, key: "attempt" },
      null,
      world.access,
    ),
  );
  assert.equal(git(job.repo, "show", ":code.txt"), "staged");
  assert.equal(
    fs.readFileSync(path.join(job.repo, "code.txt"), "utf8"),
    "working\n",
  );
});

test("publication refuses stopped or dirty work and pushes only validated ancestry", (): void => {
  const world = fixture();
  const job = writable(world);
  const publication = {
    repository: job.repo,
    branch: job.branch,
    expectedHead: world.head,
    baseHead: world.head,
  };
  const pushed: string[][] = [];
  const authority = {
    checkStop: (): void => undefined,
    push: (args: readonly string[]): void => {
      pushed.push([...args]);
      world.access.run(args);
    },
  };
  assert.throws(
    () =>
      publishCheckout(publication, {
        ...authority,
        checkStop: (): never => {
          throw new Error("stopped");
        },
      }),
    STOPPED,
  );
  fs.writeFileSync(path.join(job.repo, "code.txt"), "pending\n");
  assert.throws(() => publishCheckout(publication, authority), DIRTY);
  assert.equal(pushed.length, 0);
  commit(job.repo);
  const sha = publishCheckout(publication, authority);
  assert.equal(git(world.origin, "rev-parse", "refs/heads/work"), sha);
});

test("policy reads the pinned Git object and refuses a different repository identity", (): void => {
  const world = fixture();
  git(
    world.origin,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repo.git",
  );
  const document = path.join(world.origin, ".issue-pipeline.json");
  fs.writeFileSync(
    document,
    JSON.stringify({
      commands: { test: "npm test" },
    }),
  );
  git(world.origin, "add", ".");
  git(world.origin, "commit", "-m", "Trusted policy");
  const source = {
    repository: world.origin,
    revision: git(world.origin, "rev-parse", "HEAD"),
  };
  fs.writeFileSync(document, "untrusted candidate bytes");
  assert.equal(
    readTrustedProjectSettings(source, "https://github.com/owner/repo.git")
      .commands.test,
    "npm test",
  );
  assert.throws(
    () =>
      readTrustedProjectSettings(source, "https://github.com/other/repo.git"),
    WRONG_ORIGIN,
  );
});

test("prompt pinning rejects symlinks and keeps exact trusted bytes", (): void => {
  const world = fixture();
  fs.writeFileSync(
    path.join(world.root, "page.md"),
    "Trusted page\nExact bytes.\n",
  );
  fs.symlinkSync(
    path.join(world.root, "page.md"),
    path.join(world.root, "linked.md"),
  );
  assert.throws(() => pinPage(world.root, "linked.md"), PLAIN_FILE);
  const pinned = pinPage(world.root, "page.md");
  fs.writeFileSync(path.join(world.root, "page.md"), "Changed\nLater.");
  assert.equal(pinned.text, "Trusted page\nExact bytes.\n");
});
