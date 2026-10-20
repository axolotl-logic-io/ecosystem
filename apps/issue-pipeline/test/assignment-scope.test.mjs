// @ts-check
import "./isolated-root-test-kit.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertExecution } from "../src/assignment/authority.ts";
import { acquire, issueLock } from "../src/assignment/exclusion.ts";
import { fakeGithub } from "./assignment/fake-github.mjs";

const WITHDRAWN = /withdrawn/u;
const OUTSIDE_SCOPE = /removed from worker scope/u;
const NO_WORKER = /missing or ambiguous worker/u;
const AMBIGUOUS = /ambiguous/u;

/** @param {string} dir */
function scopeFixture(dir) {
  const fake = fakeGithub();
  fake.issue(1);
  const token = acquire(fake.hub, fake.cfg, issueLock(1), "build");
  if (token === null) {
    throw new Error("fixture executor already held");
  }
  const config = path.join(dir, "config.json");
  const manifest = path.join(dir, "manifest.json");
  const brainPath = path.join(dir, "brain");
  const entry = { config, brainPath };
  fs.writeFileSync(config, JSON.stringify(fake.cfg));
  fs.writeFileSync(manifest, JSON.stringify({ repositories: [entry] }));
  const execution = {
    worker: "build",
    issue: 1,
    stage: /** @type {const} */ ("author"),
    token,
    turn: null,
    handoff: null,
    scope: { manifest, config, brainPath },
  };
  const cfg = { ...fake.cfg, configFile: config, execution };
  return { fake, cfg, config, manifest, entry };
}

test("a running executor re-reads the operator allow-list, opt-in and worker mapping before a controlled action", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assignment-scope-"));
  try {
    const { fake, cfg, config, manifest, entry } = scopeFixture(dir);
    assertExecution(cfg, 1, true, fake.hub);
    fs.writeFileSync(
      config,
      JSON.stringify({ ...fake.cfg, assignment: undefined }),
    );
    assert.throws(() => assertExecution(cfg, 1, true, fake.hub), WITHDRAWN);
    assert.ok(fake.cfg.assignment);
    const workers = fake.cfg.assignment.workers.map((worker) => ({
      ...worker,
      id: `other-${worker.id}`,
    }));
    fs.writeFileSync(
      config,
      JSON.stringify({
        ...fake.cfg,
        assignment: { ...fake.cfg.assignment, workers },
      }),
    );
    assert.throws(() => assertExecution(cfg, 1, true, fake.hub), NO_WORKER);
    fs.writeFileSync(config, JSON.stringify(fake.cfg));
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        repositories: [{ ...entry, config: path.join(dir, "another.json") }],
      }),
    );
    assert.throws(() => assertExecution(cfg, 1, true, fake.hub), OUTSIDE_SCOPE);
    fs.writeFileSync(
      manifest,
      JSON.stringify({ repositories: [entry, entry] }),
    );
    assert.throws(() => assertExecution(cfg, 1, true, fake.hub), AMBIGUOUS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
