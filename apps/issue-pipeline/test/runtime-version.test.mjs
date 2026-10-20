// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { pinnedOf } from "./brain-test-kit.mjs";
import { privateRuntime } from "./runtime-policy-test-kit.mjs";

const { runSession } = await import("../src/job/launch.ts");
const { versionRefusal } = await import("../src/job/runtime-version.ts");
const LIMIT = 2048;
const SHIM_EXIT = 127;
const BOUNDARY_PREFIX = 660;
const OVERSIZED_LENGTH = 1000;
const RED = "\u001b[31m";
const RESET_AND_CONTROLS = "\u001b[0m\u0000\u0007\u0085\u202e";
const UNSAFE = /[\p{Cc}\p{Cf}]/u;
const SECRETS =
  /synthetic-model-secret|synthetic-openai-secret|synthetic-extra-secret/u;
const REQUIRED = /native pi executable must report version 1\.2\.0/u;
const NO_STATUS = /no normal exit status was available/u;

/** @param {ReturnType<typeof privateRuntime>} kit */
async function request(kit) {
  return await runSession(
    {
      key: "version",
      role: "author",
      agent: "issue-pipeline-author",
      model: "openai/gpt-6.1-sol",
      task: "No prompt allowed",
      outputSchema: { type: "object" },
      timeoutMs: 3000,
      commits: false,
      phase: null,
      prompt: pinnedOf("Pipeline-Prompt-Author.md"),
    },
    kit.hooks,
  );
}

/** @param {ReturnType<typeof privateRuntime>} kit @param {string} script */
function executable(kit, script) {
  fs.writeFileSync(
    path.join(kit.root, "bin", "pi"),
    `#!${process.execPath}\n${script}`,
    { mode: 0o700 },
  );
}

for (const status of [1, SHIM_EXIT]) {
  test(`version failure reports exit status ${status} and stderr without launching RPC`, async () => {
    const kit = privateRuntime();
    executable(
      kit,
      `process.stderr.write("No version is set for shim: node"); process.exit(${status});`,
    );
    const raw = await request(kit);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", REQUIRED);
    assert.ok(raw.error?.includes(`exit status ${status}`));
    assert.ok(raw.error?.includes("No version is set for shim: node"));
    assert.deepEqual(kit.calls(), []);
    assert.deepEqual(kit.records, []);
  });
}

for (const stderr of ["", "wrong tool selected"]) {
  test("successful exit with wrong version is still a diagnostic refusal", async () => {
    const kit = privateRuntime();
    executable(
      kit,
      `console.log("9.0.0"); process.stderr.write(${JSON.stringify(stderr)});`,
    );
    const raw = await request(kit);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", REQUIRED);
    assert.ok(raw.error?.includes("exit status 0"));
    assert.ok(raw.error?.includes(stderr || "stderr was empty"));
    assert.deepEqual(kit.calls(), []);
  });
}

test("redaction precedes UTF-8 truncation and no raw stderr or Error escapes", async () => {
  const kit = privateRuntime();
  Object.assign(
    kit.env,
    Object.fromEntries([
      ["PIPELINE_MODEL_KEY", "synthetic-model-secret"],
      ["OPENAI_API_KEY", "synthetic-openai-secret"],
      ["EXTRA_AUTH", "synthetic-extra-secret"],
    ]),
  );
  // Redact even the excluded native OpenAI fallback value known to runtime
  // preparation, not just the environment sent to the probe.
  const diagnostic =
    `${RED}No version${RESET_AND_CONTROLS} ` +
    "synthetic-model-secret synthetic-openai-secret synthetic-extra-secret " +
    "界".repeat(BOUNDARY_PREFIX) +
    "synthetic-model-secret" +
    "界".repeat(OVERSIZED_LENGTH);
  executable(
    kit,
    `process.stderr.write(${JSON.stringify(diagnostic)}); process.exit(127);`,
  );
  const raw = await request(kit);
  assert.equal(raw.ok, false);
  const error = raw.error ?? "";
  assert.match(error, REQUIRED);
  assert.ok(error.includes("stderr excerpt (truncated): "));
  const [, excerpt] = error.split("stderr excerpt (truncated): ");
  assert.ok(excerpt);
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= LIMIT);
  assert.ok(excerpt.includes("[redacted]"));
  assert.doesNotMatch(error, UNSAFE);
  assert.ok(!(error.includes("[31m") || error.includes("[0m")));
  assert.doesNotMatch(JSON.stringify([raw, kit.records]), SECRETS);
  assert.ok(!error.includes("\ufffd"));
  assert.deepEqual(kit.calls(), []);
  assert.deepEqual(kit.records, []);
});

test("missing executable refuses with spawn code and no normal status", async () => {
  const kit = privateRuntime();
  fs.unlinkSync(path.join(kit.root, "bin", "pi"));
  const raw = await request(kit);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", REQUIRED);
  assert.match(raw.error ?? "", NO_STATUS);
  assert.ok(raw.error?.includes("ENOENT"));
  assert.ok(raw.error?.includes("stderr was empty"));
  assert.deepEqual(kit.calls(), []);
});

test("an invalid spawn environment reports the native version and safe code before RPC", async () => {
  const kit = privateRuntime();
  Object.assign(
    kit.env,
    Object.fromEntries([
      ["PIPELINE_MODEL_KEY", "synthetic-model-secret\u0000tail"],
    ]),
  );
  const raw = await request(kit);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", REQUIRED);
  assert.match(raw.error ?? "", NO_STATUS);
  assert.ok(raw.error?.includes("ERR_INVALID_ARG_VALUE"));
  assert.ok(raw.error?.includes("stderr was empty"));
  assert.doesNotMatch(JSON.stringify([raw, kit.records]), SECRETS);
  assert.deepEqual(kit.calls(), []);
  assert.deepEqual(kit.records, []);
  assert.ok(!fs.existsSync(path.join(kit.root, "version-calls.txt")));
});

test("signal termination refuses before RPC and reports the signal", async () => {
  const kit = privateRuntime();
  executable(
    kit,
    'process.stderr.write("terminated fixture"); process.kill(process.pid, "SIGTERM");',
  );
  const raw = await request(kit);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", NO_STATUS);
  assert.ok(raw.error?.includes("termination signal SIGTERM"));
  assert.ok(raw.error?.includes("terminated fixture"));
  assert.deepEqual(kit.calls(), []);
});

test("timeout diagnostics use the same bounded sanitizer without relying on elapsed test time", () => {
  /** @type {NodeJS.ErrnoException} */
  const error = new Error("synthetic-model-secret raw attached error");
  error.code = "ETIMEDOUT";
  const stderr = `${RED}synthetic-model-secret ${"界".repeat(OVERSIZED_LENGTH)}`;
  const refusal = versionRefusal(
    {
      pid: 1,
      output: [null, "", stderr],
      stdout: "",
      stderr,
      status: null,
      signal: "SIGTERM",
      error,
    },
    Object.fromEntries([["PIPELINE_MODEL_KEY", "synthetic-model-secret"]]),
    ["PIPELINE_MODEL_KEY"],
  );
  assert.match(refusal ?? "", NO_STATUS);
  assert.ok(refusal?.includes("timed out (ETIMEDOUT)"));
  assert.ok(refusal?.includes("termination signal SIGTERM"));
  assert.doesNotMatch(refusal ?? "", SECRETS);
  assert.doesNotMatch(refusal ?? "", UNSAFE);
  const excerpt = refusal?.split("stderr excerpt (truncated): ")[1];
  assert.ok(excerpt);
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= LIMIT);
});

test("a credential crossing the byte boundary is redacted before slicing", () => {
  const secret = "synthetic-model-secret";
  const prefix = "x".repeat(LIMIT - Buffer.byteLength("[redacted]"));
  const stderr = `${prefix}${secret}${"界".repeat(OVERSIZED_LENGTH)}`;
  const refusal = versionRefusal(
    {
      pid: 1,
      output: [null, "", stderr],
      stdout: "",
      stderr,
      status: 1,
      signal: null,
    },
    Object.fromEntries([["PIPELINE_MODEL_KEY", secret]]),
    ["PIPELINE_MODEL_KEY"],
  );
  const [, excerpt] = (refusal ?? "").split("stderr excerpt (truncated): ");
  assert.equal(excerpt, `${prefix}[redacted]`);
  assert.doesNotMatch(refusal ?? "", SECRETS);
});

for (const interruption of ["\u001b[31m", "\u0000", "\u0007", "\u202e"]) {
  test("controls inside a known credential cannot leave readable credential fragments", () => {
    const secret = "synthetic-model-secret";
    const stderr = `No version: synthetic-mo${interruption}del-secret`;
    const refusal = versionRefusal(
      {
        pid: 1,
        output: [null, "", stderr],
        stdout: "",
        stderr,
        status: 1,
        signal: null,
      },
      Object.fromEntries([["SERVICE_ACCESS", secret]]),
      ["SERVICE_ACCESS"],
    );
    assert.ok(refusal?.includes("stderr excerpt: No version: [redacted]"));
    assert.ok(!refusal?.includes("synthetic"));
    assert.doesNotMatch(refusal ?? "", UNSAFE);
  });
}

for (const length of [LIMIT - 1, LIMIT, LIMIT + 1]) {
  test(`the stderr byte boundary is applied after sanitization at ${length} bytes`, () => {
    // Large raw output can sanitize below the limit. ANSI bytes must not cause
    // a false truncation marker or consume the reportable byte budget.
    const stderr = `${RED.repeat(LIMIT)}${"x".repeat(length)}`;
    const refusal = versionRefusal(
      {
        pid: 1,
        output: [null, "", stderr],
        stdout: "",
        stderr,
        status: 1,
        signal: null,
      },
      {},
      [],
    );
    let label = "stderr excerpt: ";
    if (length > LIMIT) {
      label = "stderr excerpt (truncated): ";
    }
    const [, excerpt] = (refusal ?? "").split(label);
    assert.equal(excerpt, "x".repeat(Math.min(length, LIMIT)));
    assert.doesNotMatch(refusal ?? "", UNSAFE);
  });
}
