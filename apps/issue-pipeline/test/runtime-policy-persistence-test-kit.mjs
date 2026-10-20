// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pinnedOf } from "./brain-test-kit.mjs";
import { messageEnd, toolEnd } from "./fake-rpc-pi.mjs";
import { MODEL, privateRuntime } from "./runtime-policy-test-kit.mjs";

/** @import { SessionLaunch } from "../src/job/launch.ts" */
/** @import { JobStatus } from "../src/job/status.ts" */
const { nativeSettings, policyOf } = await import(
  "../src/job/runtime-policy.ts"
);
const { openStatus } = await import("../src/job/status.ts");

const USAGE = {
  input: 50,
  output: 10,
  cacheRead: 20,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
};

/** @param {Partial<SessionLaunch>} [changes] @returns {SessionLaunch} */
function launch(changes = {}) {
  return {
    key: "author-1",
    role: "author",
    agent: "issue-pipeline-author",
    model: "openai/gpt-6.1-sol",
    task: "Offline fixture task",
    outputSchema: { type: "object" },
    timeoutMs: 3000,
    commits: false,
    phase: null,
    prompt: pinnedOf("Pipeline-Prompt-Author.md"),
    ...changes,
  };
}

/** @param {string} stage @returns {ReturnType<typeof privateRuntime> & {status: JobStatus, file: string}} */
function recordedRuntime(stage) {
  const kit = privateRuntime();
  const file = path.join(kit.root, "job.json");
  const status = openStatus(kit.root, {
    id: "runtime-evidence",
    issue: 109,
    stage,
    lane: null,
    startedAt: "2026-10-20T12:00:00Z",
    socket: "/unused",
    prompts: [],
  });
  kit.hooks.started = (start) => status.started(start);
  kit.hooks.ended = status.ended;
  const originalRecord = kit.hooks.record;
  kit.hooks.record = (key, record) => {
    originalRecord(key, record);
    status.record(key, record);
  };
  Object.assign(
    kit.env,
    Object.fromEntries([
      ["FAKE_STATUS_FILE", file],
      [
        "FAKE_SESSION_EVENTS",
        JSON.stringify([messageEnd(USAGE), toolEnd(true)]),
      ],
    ]),
  );
  return { ...kit, status, file };
}

/** @param {string} text @returns {string} */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Build the expected evidence independently from the diagnostic callback,
// using the explicit policy and exact file bytes the integrity checks use.
/** @param {ReturnType<typeof privateRuntime>} kit @param {string} [model] @param {string} [endpoint] */
function expectedPolicy(
  kit,
  model = "openai/gpt-6.1-sol",
  endpoint = MODEL.baseUrl,
) {
  const policy = policyOf(model, kit.runtime);
  return {
    type: "runtime_policy",
    ...policy,
    endpoint,
    settingsSha256: sha256(JSON.stringify(nativeSettings(policy))),
    providerConfigSha256: sha256(
      fs.readFileSync(path.join(kit.providerDir, "config.json"), "utf8"),
    ),
    providerCacheSha256: sha256(
      fs.readFileSync(
        path.join(kit.providerDir, "discovery-cache.json"),
        "utf8",
      ),
    ),
    nativeVersion: "1.2.0",
    providerVersion: "0.4.3",
  };
}

export { expectedPolicy, launch, recordedRuntime, USAGE };
