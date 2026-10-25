// Actual authorization refuses stale legacy policy before any GitHub mutation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  calls,
  consumed,
  prechecks,
  request,
  script,
} from "./explicit-target-test-kit.ts";
import { world } from "./explicit-target-world-test-kit.ts";

const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { merge }: typeof import("../src/ops/merge.ts") = await import(
  "../src/ops/merge.ts"
);
const { policyRevision }: typeof import("../src/project-policy.ts") =
  await import("../src/project-policy.ts");
const { ISSUE_STATE }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { runOps }: typeof import("./ops-run-test-kit.ts") = await import(
  "./ops-run-test-kit.ts"
);
const PRECHECKS_THROUGH_REVISION = 5;
const POLICY_CHANGED = /policy changed since this job/u;

for (const change of [{ commands: { test: "false" } }, { requireCi: false }]) {
  test(`changed operator checking policy cannot reuse earlier hardening: ${JSON.stringify(change)}`, () => {
    const w = world();
    const file = path.join(w.place, "config.json");
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...original, ...change }));
    const cfg = { ...loadConfig(file), slug: w.cfg.slug };
    script(w, prechecks(w).slice(0, PRECHECKS_THROUGH_REVISION));
    const result = merge(cfg, request(w));
    assert.equal(result.merged, false);
    assert.ok("reason" in result);
    assert.equal(result.reason, "stale");
    assert.equal(
      calls().some((args) => args.includes("POST")),
      false,
    );
    consumed();
    assert.equal(ISSUE_STATE.parse(w.state).headSha, w.head);
    assert.deepEqual(ISSUE_STATE.parse(w.state).hardened, w.revision);
  });
}

test("historical unbound hardening stays readable but cannot authorize a new merge", () => {
  const w = world();
  const { policy: _unknown, ...historical } = w.revision;
  const saved = ISSUE_STATE.parse({ ...w.state, hardened: historical });
  script(w, prechecks(w).slice(0, PRECHECKS_THROUGH_REVISION));
  const result = merge(w.cfg, {
    ...request(w),
    state: saved,
    revision: historical,
  });
  assert.equal(result.merged, false);
  assert.ok("reason" in result);
  assert.equal(result.reason, "stale");
  assert.deepEqual(saved.hardened, historical);
  assert.equal(saved.headSha, w.head);
  assert.equal(
    calls().some((args) => args.includes("POST")),
    false,
  );
  consumed();
});

test("ops reload computes policy itself and refuses changed policy before queued comments", () => {
  const w = world();
  const file = path.join(w.place, "config.json");
  const original = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...original, commands: { test: "false" } }),
  );
  script(w, []);
  const output = runOps({
    config: file,
    root: w.place,
    home: w.place,
    request: {
      op: "post",
      policyDigest: policyRevision(w.cfg).policy,
      comments: [{ number: w.state.number, body: "must not post" }],
    },
  });
  const reply = JSON.parse(output);
  assert.equal(reply.ok, false);
  assert.match(reply.error, POLICY_CHANGED);
  assert.deepEqual(calls(), []);
  consumed();
});
