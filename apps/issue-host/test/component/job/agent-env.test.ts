import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_SCOPE_ENV } from "@ecosystem/task-runtime/job/pipeline-commit";
import { agentEnvOf } from "../../../src/job/agent-env.ts";

test("model children strip every legacy access credential and inherited commit scope", () => {
  const env = agentEnvOf(
    {
      reader: { tokenEnv: "READ_KEY", network: ["example.org"] },
      writer: { tokenEnv: "WRITE_KEY" },
      lander: { tokenEnv: "LAND_KEY" },
    },
    Object.fromEntries([
      ["READ_KEY", "read"],
      ["WRITE_KEY", "write"],
      ["LAND_KEY", "land"],
      ["GH_TOKEN", "github"],
      [COMMIT_SCOPE_ENV, "inherited"],
      ["PIPELINE_MODEL_KEY", "model"],
      ["PATH", "/bin"],
    ]),
  );
  assert.deepEqual(
    env,
    Object.fromEntries([
      ["PIPELINE_MODEL_KEY", "model"],
      ["PATH", "/bin"],
    ]),
  );
});

test("absent access metadata still strips standard credentials and commit scope", () => {
  assert.deepEqual(
    agentEnvOf(
      undefined,
      Object.fromEntries([
        ["GH_TOKEN", "github"],
        [COMMIT_SCOPE_ENV, "old"],
        ["PATH", "/bin"],
      ]),
    ),
    Object.fromEntries([["PATH", "/bin"]]),
  );
});
