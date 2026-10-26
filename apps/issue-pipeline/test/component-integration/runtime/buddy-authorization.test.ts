// A buddy's authorization as an ops child binds it: `bindBuddyAuthorization`
// in a fresh process over real files and a real pinned project policy,
// against the digest the operator's `src/buddy.ts --check` reported.
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { test } from "node:test";
import { z } from "zod";
import type { Sandbox } from "../../support/runtime/buddy-test-kit.ts";
import {
  digestOf,
  run,
  SHA256,
  sandbox,
} from "../../support/runtime/buddy-test-kit.ts";

const BOUND = z.strictObject({
  authorization: z.strictObject({
    config: z.string(),
    repository: z.string(),
    run: z.string(),
    task: z.string(),
    digest: SHA256,
  }),
  policyUnchanged: z.boolean(),
});
// An ops child's binding: loads the repository config, binds it to the
// envelope and reports the internal authorization and whether the shared
// checking policy was left alone.
const BINDER = `
import { loadConfig } from './src/config.ts';
import { bindBuddyAuthorization } from './src/runtime/buddy-config.ts';
const [file, envelope] = process.argv.slice(1);
const cfg = loadConfig(file);
const bound = bindBuddyAuthorization(cfg, file, JSON.parse(envelope));
console.log(JSON.stringify({
  authorization: bound.buddyAuthorization,
  policyUnchanged: JSON.stringify(bound.policyBinding) === JSON.stringify(cfg.policyBinding),
}));
`;
const RUN = "6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const GATEKEEPER = {
  name: "lawd",
  role: "gatekeeper",
  identity: {
    name: "lawd",
    account: { provider: "github", login: "REVIEW-MERGE-BOT" },
    profiles: ["reader", "lander"],
  },
};

interface Envelope {
  config: string;
  run: string;
  task: string;
  authorizationDigest: string;
}

function bind(box: Sandbox, envelope: object): SpawnSyncReturns<string> {
  return run(
    [
      "--input-type=module",
      "--eval",
      BINDER,
      box.repository,
      JSON.stringify(envelope),
    ],
    box.root,
  );
}

function landEnvelope(box: Sandbox, file: string): Envelope {
  return {
    config: file,
    run: RUN,
    task: "land",
    authorizationDigest: digestOf(box, file),
  };
}

test("bindBuddyAuthorization binds the action's digest without touching the shared policy", () => {
  const box = sandbox(false);
  try {
    const file = box.buddy({});
    const digest = digestOf(box, file);
    const envelope = {
      config: file,
      run: RUN,
      task: "implement",
      authorizationDigest: digest,
    };
    const bound = bind(box, envelope);
    assert.equal(bound.status, 0, bound.stderr);
    const result = BOUND.parse(JSON.parse(bound.stdout));
    assert.equal(result.policyUnchanged, true);
    assert.deepEqual(result.authorization, {
      config: file,
      repository: box.repository,
      run: RUN,
      task: "implement",
      digest,
    });
    const foreignTask = bind(box, { ...envelope, task: "land" });
    assert.notEqual(foreignTask.status, 0);
    assert.ok(
      foreignTask.stderr.includes("responsibilities"),
      foreignTask.stderr,
    );
    box.buddy({ pollSeconds: 120 });
    const changed = bind(box, envelope);
    assert.notEqual(changed.status, 0);
    assert.ok(
      changed.stderr.includes("changed since the action began"),
      changed.stderr,
    );
  } finally {
    box.cleanup();
  }
});

test("Land binds only when both the buddy and the repository grant it", () => {
  const refused = sandbox(false);
  const granted = sandbox(true);
  try {
    const permitted = { ...GATEKEEPER, permissions: { land: true } };
    const repositoryRefuses = bind(
      refused,
      landEnvelope(refused, refused.buddy(permitted)),
    );
    assert.notEqual(repositoryRefuses.status, 0);
    assert.ok(
      repositoryRefuses.stderr.includes(
        "owner/repo's config grants no Land permission",
      ),
      repositoryRefuses.stderr,
    );
    const bothGrant = bind(
      granted,
      landEnvelope(granted, granted.buddy(permitted)),
    );
    assert.equal(bothGrant.status, 0, bothGrant.stderr);
    const buddyRefuses = bind(
      granted,
      landEnvelope(granted, granted.buddy(GATEKEEPER)),
    );
    assert.notEqual(buddyRefuses.status, 0);
    assert.ok(
      buddyRefuses.stderr.includes(
        "the buddy config grants no Land permission",
      ),
      buddyRefuses.stderr,
    );
  } finally {
    refused.cleanup();
    granted.cleanup();
  }
});
