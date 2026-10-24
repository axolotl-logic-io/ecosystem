// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { git, policyFixture } from "./project-policy-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { configPolicyDigest, policyRevision } = await import(
  "../src/project-policy.ts"
);
const { opsFrameOf } = await import("../src/job/ops-request.ts");
const { openStatus, readStatus } = await import("../src/job/status.ts");
const ISSUE = 7;

for (const mode of ["committed", "legacy"]) {
  test(`${mode} settings snapshot and child expectation stay consistent across session records`, () => {
    const fx = policyFixture({
      commands: { setup: "printf setup", test: "printf check" },
    });
    if (mode === "legacy") {
      const { projectPolicy: _source, ...operator } = fx.operator;
      fs.writeFileSync(
        fx.file,
        JSON.stringify({
          ...operator,
          commands: { setup: "printf setup", test: "printf check" },
        }),
      );
    }
    const cfg = loadConfig(fx.file);
    const dir = path.join(fx.dir, "run");
    const status = openStatus(
      dir,
      {
        id: "test-job",
        issue: ISSUE,
        stage: "review",
        lane: "test-lane",
        startedAt: "2026-10-21T00:00:00Z",
        socket: "/test-socket",
        prompts: [],
      },
      cfg.policyBinding,
    );
    const first = opsFrameOf(
      cfg,
      fx.file,
      {
        lane: "test-lane",
        sweepId: "test",
        execution: {
          instance: "00000000-0000-4000-8000-000000000001",
          lane: "test-lane",
          issue: ISSUE,
          branch: "test-branch",
          repo: cfg.repo,
          base: cfg.baseBranch,
        },
      },
      { issue: ISSUE, dir: fx.dir, branch: "test-branch" },
    );
    status.started({
      key: "session-1",
      kind: "session",
      pid: null,
      session: "first.jsonl",
    });
    status.started({
      key: "session-2",
      kind: "session",
      pid: null,
      session: "second.jsonl",
    });
    const saved = readStatus(dir);
    assert.equal(saved?.policyBinding?.mode, mode);
    const { commands } = saved?.policyBinding?.settings ?? {};
    assert.deepEqual(commands, cfg.commands);
    assert.equal(saved?.policyBinding?.digest, first.policyDigest);
    assert.equal(first.policyDigest, configPolicyDigest(cfg));
    assert.equal(
      first.policyDigest,
      policyRevision(loadConfig(fx.file)).policy,
    );
    assert.equal(saved?.launches.length, 2);
  });
}

test("credential locations and operator JSON key order do not alter legacy check policy", () => {
  const fx = policyFixture();
  const { projectPolicy: _source, ...operator } = fx.operator;
  fs.writeFileSync(
    fx.file,
    JSON.stringify({ ...operator, commands: { test: "true", setup: "true" } }),
  );
  const before = loadConfig(fx.file);
  fs.writeFileSync(
    fx.file,
    JSON.stringify({
      commands: { setup: "true", test: "true" },
      ...operator,
      credentialsEnvFile: "/unread/synthetic/credential-file",
    }),
  );
  const after = loadConfig(fx.file);
  assert.deepEqual(after.policyBinding, before.policyBinding);
  assert.equal(
    JSON.stringify(after.policyBinding).includes("/unread/synthetic"),
    false,
  );
});

test("Git replacement objects cannot replace the operator-pinned checking policy", () => {
  const fx = policyFixture({ commands: { test: "printf trusted" } });
  const before = loadConfig(fx.file);
  fs.writeFileSync(
    path.join(fx.dir, ".issue-pipeline.json"),
    '{"commands":{"test":"printf weakened"}}',
  );
  git(fx.dir, ["add", ".issue-pipeline.json"]);
  git(fx.dir, ["commit", "--quiet", "-m", "candidate policy"]);
  const candidate = git(fx.dir, ["rev-parse", "HEAD"]);
  git(fx.dir, ["replace", fx.revision, candidate]);
  const after = loadConfig(fx.file);
  assert.equal(after.commands.test, "printf trusted");
  assert.deepEqual(after.policyBinding, before.policyBinding);
});

const OVERSIZED_POLICY_BYTES = 131_072;
const INVALID_UTF8_BYTE = 0xff;
test("empty, oversized, NUL and invalid UTF-8 committed documents refuse explicitly", () => {
  const documents = [
    Buffer.alloc(0),
    Buffer.alloc(OVERSIZED_POLICY_BYTES, " "),
    Buffer.from([0]),
    Buffer.from([INVALID_UTF8_BYTE]),
  ];
  for (const document of documents) {
    const fx = policyFixture();
    fs.writeFileSync(path.join(fx.dir, ".issue-pipeline.json"), document);
    git(fx.dir, ["add", ".issue-pipeline.json"]);
    git(fx.dir, ["commit", "--quiet", "-m", "invalid policy text"]);
    fx.save({
      projectPolicy: {
        repository: fx.dir,
        revision: git(fx.dir, ["rev-parse", "HEAD"]),
      },
    });
    assert.throws(() => loadConfig(fx.file));
  }
});

test("a committed duplicate command cannot silently choose the last checking value", () => {
  const fx = policyFixture();
  fs.writeFileSync(
    path.join(fx.dir, ".issue-pipeline.json"),
    '{"commands":{"test":"printf trusted","test":"true"}}',
  );
  git(fx.dir, ["add", ".issue-pipeline.json"]);
  git(fx.dir, ["commit", "--quiet", "-m", "ambiguous policy"]);
  fx.save({
    projectPolicy: {
      repository: fx.dir,
      revision: git(fx.dir, ["rev-parse", "HEAD"]),
    },
  });
  assert.throws(() => loadConfig(fx.file));
});
