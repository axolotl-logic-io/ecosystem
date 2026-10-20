// @ts-check
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  delivery,
  fixture,
  git,
  QUERIES,
  query,
  snapshot,
  syntheticEnvironment,
} from "./git-review-test-kit.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { gitEnvironment } = await import("../src/job/git-review-process.ts");
const { queryOf } = await import("../src/job/git-review-policy.ts");
const UNSUPPORTED = /Unsupported/u;
const TRANSPORT_REFUSED = /transport 'https' not allowed/u;

for (const argv of QUERIES) {
  test(`serves ${argv[0]} without modifying repository state`, async () => {
    const { repo, tool } = fixture();
    const before = snapshot(repo);
    const result = await query(tool, repo, argv);
    assert.equal(delivery(result).repository, repo);
    assert.deepEqual(delivery(result).argv, argv);
    assert.equal(snapshot(repo), before);
  });
}

for (const command of [
  "fetch",
  "push",
  "ls-remote",
  "checkout",
  "config",
  "arbitrary",
]) {
  test(`refuses ${command} before executing Git`, () => {
    assert.throws(() => queryOf([command]), UNSUPPORTED);
  });
}

const DANGEROUS = [
  ["-c", "credential.helper=sentinel"],
  ["-ccredential.helper=sentinel"],
  ["--config-env=credential.helper=SENTINEL"],
  ["--config-env", "credential.helper=SENTINEL"],
  ["--output=review.patch"],
  ["--output", "review.patch"],
  ["-o", "review.patch"],
  ["-oreview.patch"],
  ["--ext-diff"],
  ["--textconv"],
  ["--exec-path=/outside/programs"],
  ["--exec-path", "/outside/programs"],
  ["--upload-pack=/outside/program"],
  ["--upload-pack", "/outside/program"],
  ["--git-dir=/outside/repository.git"],
  ["--git-dir", "/outside/repository.git"],
];
for (const option of DANGEROUS) {
  test(`rejects ${option.join(" ")} and alternate command positions`, () => {
    for (const argv of [
      ["diff", ...option],
      ["diff", "HEAD", ...option],
      [...option, "diff"],
    ]) {
      assert.throws(
        () => queryOf(argv),
        (error) =>
          error instanceof Error && error.message.includes(option[0] ?? ""),
      );
    }
  });
}

const UNSAFE_MODES = [
  ["diff", "--no-index", "file.txt", "/outside/file"],
  ["diff", "--src-prefix=/outside"],
  ["show", "--open-files-in-pager"],
  ["show", "--format=%G?"],
  ["log", "--show-signature"],
  ["log", "--format=%GG"],
  ["rev-parse", "--resolve-git-dir", "/outside"],
  ["rev-parse", "--git-path", "config"],
  ["rev-parse", "--local-env-vars"],
  ["rev-parse", "--sq-quote", "--output=oops"],
  ["cat-file", "--filters", "HEAD:file.txt"],
  ["cat-file", "--batch-command"],
  ["cat-file", "--textconv", "HEAD:file.txt"],
  ["cat-file", "-p", ":/outside"],
  ["blame", "--contents", "/outside"],
  ["grep", "-f", "/outside"],
  ["grep", "--no-index", "-e", "secret", "--", "/outside"],
  ["grep", "--recurse-submodules", "-e", "line"],
  ["status", "--ignored", "--recurse-submodules"],
  ["ls-tree", "--format=%G?", "HEAD"],
  ["merge-base", "--fork-point", "HEAD"],
];
for (const argv of UNSAFE_MODES) {
  test(`rejects unsafe mode ${argv.join(" ")}`, () => {
    assert.throws(() => queryOf(argv), UNSUPPORTED);
  });
}

test("spawns Git directly with an empty HOME and a constant credential-free environment", async ({
  mock,
}) => {
  const { repo, tool } = fixture();
  const host = path.join(isolatedRoot, "host-home");
  fs.mkdirSync(host);
  fs.writeFileSync(
    path.join(host, ".gitconfig"),
    "[credential]\nhelper = sentinel\n[alias]\nstatus = !sentinel\n",
  );
  mock.property(process, "env", syntheticEnvironment(host));
  const original = childProcess.spawn;
  let calls = 0;
  let spawnedHome = "";
  mock.method(
    childProcess,
    "spawn",
    /** @param {string} file @param {string[]} args @param {import("node:child_process").SpawnOptions} options @returns {import("node:child_process").ChildProcess} */ (
      file,
      args,
      options,
    ) => {
      calls += 1;
      assert.equal(file, "/usr/bin/git");
      assert.equal(options?.shell, false);
      const env = options?.env ?? {};
      const { HOME: home } = env;
      assert.ok(home);
      assert.notEqual(home, host);
      spawnedHome = home;
      assert.deepEqual(fs.readdirSync(home), []);
      assert.deepEqual(env, gitEnvironment(home));
      assert.ok(args?.includes("--no-pager"));
      assert.ok(args?.includes("--no-ext-diff"));
      assert.ok(args?.includes("--no-textconv"));
      return original(file, args, options);
    },
  );
  syncBuiltinESMExports();
  try {
    delivery(await query(tool, repo, ["show", "HEAD"]));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(spawnedHome), false);
    await query(tool, repo, ["fetch"]);
    await query(tool, repo, ["diff", "--output=oops"]);
    assert.equal(calls, 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("repository and host config cannot invoke external programs", async () => {
  const { repo, tool } = fixture();
  const marker = path.join(repo, "executed");
  const sentinel = path.join(repo, "sentinel");
  fs.writeFileSync(
    sentinel,
    `#!/bin/sh\nprintf invoked > '${marker}'\nexit 1\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(repo, ".gitattributes"),
    "*.txt diff=sentinel filter=sentinel\n",
  );
  const settings = [
    ["diff.external", sentinel],
    ["diff.sentinel.command", sentinel],
    ["diff.sentinel.textconv", sentinel],
    ["core.pager", sentinel],
    ["pager.show", sentinel],
    ["core.fsmonitor", sentinel],
    ["credential.helper", `!${sentinel}`],
    ["alias.status", `!${sentinel}`],
    ["gpg.program", sentinel],
    ["log.showSignature", "true"],
    ["filter.sentinel.clean", sentinel],
    ["filter.sentinel.smudge", sentinel],
    ["core.sshCommand", sentinel],
    ["include.path", "/outside/nonexistent"],
  ];
  for (const [key, value] of settings) {
    assert.ok(key && value);
    git(repo, ["config", "--local", key, value]);
  }
  fs.appendFileSync(path.join(repo, "file.txt"), "third\n");
  const before = snapshot(repo);
  await QUERIES.reduce(async (previous, argv) => {
    await previous;
    delivery(await query(tool, repo, argv));
  }, Promise.resolve());
  assert.equal(fs.existsSync(marker), false);
  assert.equal(snapshot(repo), before);
});

test("non-file transport is refused below validation without connecting", () => {
  const home = path.join(isolatedRoot, "transport-home");
  fs.mkdirSync(home);
  const result = childProcess.spawnSync(
    "/usr/bin/git",
    ["ls-remote", "https://127.0.0.1:1/sentinel"],
    {
      cwd: home,
      env: gitEnvironment(home),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, TRANSPORT_REFUSED);
});

test("the child policy contains only the documented minimal environment", () => {
  const home = "/empty-temporary-home";
  assert.deepEqual(
    gitEnvironment(home),
    Object.fromEntries([
      ["HOME", home],
      ["XDG_CONFIG_HOME", home],
      ["PATH", "/usr/bin:/bin"],
      ["LC_ALL", "C"],
      ["TZ", "UTC"],
      ["GIT_CONFIG_GLOBAL", "/dev/null"],
      ["GIT_CONFIG_SYSTEM", "/dev/null"],
      ["GIT_CONFIG_NOSYSTEM", "1"],
      ["GIT_TERMINAL_PROMPT", "0"],
      ["GIT_ALLOW_PROTOCOL", "file"],
      ["GIT_NO_REPLACE_OBJECTS", "1"],
      ["GIT_OPTIONAL_LOCKS", "0"],
      ["GIT_ATTR_NOSYSTEM", "1"],
    ]),
  );
});

test("cancelled requests return no delivery record", async () => {
  const { repo, tool } = fixture();
  const result = await tool.execute(
    "cancelled",
    { cwd: repo, argv: ["log"] },
    AbortSignal.abort(),
  );
  assert.equal(result.isError, true);
  assert.ok("error" in result.details);
});

test("the private view preserves SHA-256 object identity", async () => {
  const { repo } = fixture();
  const sha256 = path.join(repo, "sha256");
  fs.mkdirSync(sha256);
  git(sha256, ["init", "-q", "--object-format=sha256"]);
  fs.writeFileSync(path.join(sha256, "file.txt"), "sha256 evidence\n");
  git(sha256, ["add", "."]);
  git(sha256, ["commit", "-qm", "sha256"]);
  const { reviewer } = await import("../src/job/git-review.ts");
  const result = await query(reviewer(JSON.stringify([sha256])), sha256, [
    "rev-parse",
    "HEAD",
  ]);
  assert.ok(
    result.content[0]?.text.includes(git(sha256, ["rev-parse", "HEAD"]).trim()),
  );
  assert.equal(delivery(result).totalLines, 1);
});
