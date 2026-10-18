// @ts-check
// A role's session runs in a stage job as the sweep would launch it (#416):
// with the minutes its effect names as its timeout, and a writer's
// acceptance when the effect is a writer's, so the finalizer's wiki
// conflict resolver gets its 45 minutes and runs as a writer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLaunchOf } from "../src/job/role-launches.ts";
import { childSpec } from "../src/workflow/launches.ts";
import { finalize } from "./finalizer-role-test-kit.mjs";

/** @import { SessionEffect } from "../src/roles/machine.ts" */

const MINUTE_MS = 60_000;
// The conflict resolver's timeout, and every other session's default.
const RESOLVER_MINUTES = 45;
const DEFAULT_MINUTES = 30;
const ITEM = { n: 7, worktree: "/jobs/issue-7-merge/repo" };

/**
 * @returns {Promise<SessionEffect | undefined>} the session the finalizer
 * runs on a wiki conflict: the conflict resolver
 */
async function resolverEffect() {
  const run = await finalize({ wiki: true, wikiConflict: true });
  return run.sessions[0];
}

test("the finalizer's wiki conflict resolver launches as a writer with its minutes", async () => {
  const effect = await resolverEffect();
  assert.ok(effect !== undefined, "the resolver session ran");
  const launch = sessionLaunchOf(effect);
  assert.equal(launch.writer, true);
  assert.equal(launch.minutes, RESOLVER_MINUTES);
  const spec = childSpec(1, ITEM, launch, {});
  assert.equal(spec.timeoutMs, RESOLVER_MINUTES * MINUTE_MS);
  assert.equal(spec.acceptance?.level, "none");
});

test("a role session with no minutes and no writer flag gets the default timeout and no acceptance", async () => {
  const effect = await resolverEffect();
  assert.ok(effect !== undefined, "the resolver session ran");
  const { minutes: _minutes, writer: _writer, ...reader } = effect;
  const launch = sessionLaunchOf(reader);
  assert.equal(launch.writer, undefined);
  const spec = childSpec(1, ITEM, launch, {});
  assert.equal(spec.timeoutMs, DEFAULT_MINUTES * MINUTE_MS);
  assert.equal(spec.acceptance, undefined);
});
