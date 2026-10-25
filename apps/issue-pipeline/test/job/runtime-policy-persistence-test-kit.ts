import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NativePolicy } from "../../src/job/runtime-policy.ts";
import type { JobStatus, LaunchStart } from "../../src/job/status.ts";
import { messageEnd, toolEnd } from "../fake-rpc-pi.ts";
import { MODEL, privateRuntime } from "./runtime-policy-test-kit.ts";

const {
  nativeSettings,
  policyOf,
}: typeof import("../../src/job/runtime-policy.ts") = await import(
  "../../src/job/runtime-policy.ts"
);
const { openStatus }: typeof import("../../src/job/status.ts") = await import(
  "../../src/job/status.ts"
);

const USAGE = {
  input: 50,
  output: 10,
  cacheRead: 20,
  cacheWrite: 0,
  cacheWrite1h: 0,
  cost: 0,
};

function recordedRuntime(
  stage: string,
): ReturnType<typeof privateRuntime> & { status: JobStatus; file: string } {
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
  kit.hooks.started = (start: LaunchStart): void => status.started(start);
  kit.hooks.ended = status.ended;
  const originalRecord = kit.hooks.record;
  kit.hooks.record = (key: string, record: unknown): void => {
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

// The runtime_policy evidence a session records: its native policy, where
// the model is and the digests and versions of what the runtime ran.
type PolicyEvidence = NativePolicy & {
  type: "runtime_policy";
  endpoint: string;
  settingsSha256: string;
  providerConfigSha256: string;
  providerCacheSha256: string;
  nativeVersion: string;
  providerVersion: string;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Build the expected evidence independently from the diagnostic callback,
// using the explicit policy and exact file bytes the integrity checks use.
function expectedPolicy(
  kit: ReturnType<typeof privateRuntime>,
  model = "openai/gpt-6.1-sol",
  endpoint: string = MODEL.baseUrl,
): PolicyEvidence {
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

export { expectedPolicy, recordedRuntime, USAGE };
