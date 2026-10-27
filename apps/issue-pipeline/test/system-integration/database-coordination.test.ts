import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, test } from "node:test";
import { executeCoordination } from "@ecosystem/db/coordination";
import type { Binding, Command } from "@ecosystem/db/protocol";
import { RESPONSE, VIEW } from "@ecosystem/db/protocol";
import { createTestDatabase, type TestDatabase } from "@ecosystem/db/testing";
import { z } from "zod";
import { childEnvironment } from "../../src/child-env.ts";
import { committedPolicy } from "../support/project-policy-test-kit.ts";

const at: TestDatabase = await createTestDatabase();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-database-"));
after(async (): Promise<void> => {
  try {
    await at.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const root = path.join(dir, "root");
fs.mkdirSync(root);
const credentials = path.join(dir, "database.env");
const PRIVATE_MODE = 0o600;
const WORLD_READABLE = 0o644;
fs.writeFileSync(credentials, `DATABASE_URL=${at.url}\n`, {
  mode: PRIVATE_MODE,
});
const built = path.resolve(import.meta.dirname, "../../dist/database.mjs");
const relocated = path.join(dir, "database.mjs");
fs.copyFileSync(built, relocated);
const DRIVER = path.resolve(
  import.meta.dirname,
  "../component-integration/reservation-driver.ts",
);
const DEADLINE_MS = 30_000;
const NEWLINE = /\r?\n/u;
const FULL = /every model-session slot is taken/u;
const LIVE = /consumers not yet done/u;
const UNREADABLE = /unreadable or unconfirmed/u;
const OUTCOME = z.object({
  state: z.string().optional(),
  released: z.boolean().optional(),
  reason: z.string().optional(),
});

function invoke(
  file: string,
  input: unknown,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      cwd: dir,
      env: {
        ...childEnvironment(process.env),
        ...env,
        ...Object.fromEntries([["ISSUE_PIPELINE_ROOT", root]]),
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: DEADLINE_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string): void => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string): void => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code: number | null): void => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(JSON.stringify(input));
  });
}
function who(repo: string, issue = 1): Binding {
  return {
    repo,
    base: "main",
    issue,
    instance: crypto.randomUUID(),
    lane: `test:${issue}`,
    branch: `agent/issue-${issue}`,
  };
}
function request(binding: Binding): Command {
  return {
    operation: "claim",
    repo: binding.repo,
    base: binding.base,
    binding,
    scope: { kind: "issue", issue: binding.issue },
  };
}
function config(repo: string): string {
  const folder = fs.mkdtempSync(path.join(dir, "configuration-"));
  const ghCredential = path.join(folder, "github.env");
  fs.writeFileSync(
    ghCredential,
    "ISSUE_PIPELINE_DEV_GITHUB_TOKEN=dev-token\nISSUE_PIPELINE_LANDING_GITHUB_TOKEN=landing-token\n",
    { mode: PRIVATE_MODE },
  );
  const file = path.join(folder, "repository.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      repo,
      devAccount: "dev-bot",
      landingAccount: "land-bot",
      credentialsEnvFile: ghCredential,
      allowedUsers: ["alice"],
      baseBranch: "main",
      coordination: {
        backend: "postgres",
        credentialsEnvFile: credentials,
      },
      projectPolicy: committedPolicy(
        path.join(folder, "policy"),
        `https://github.com/${repo}.git`,
        { commands: { test: "true" }, resources: { modelSessions: 1 } },
      ),
    }),
  );
  return file;
}

test("relocated database distribution claims atomically with no source dependencies", async (): Promise<void> => {
  const repo = `tests/${crypto.randomUUID()}`;
  const first = who(repo);
  const second = who(repo);
  const replies = await Promise.all(
    [first, second].map(
      (binding): ReturnType<typeof invoke> =>
        invoke(relocated, {
          credentialsEnvFile: credentials,
          command: request(binding),
        }),
    ),
  );
  const results = replies.map((reply) =>
    RESPONSE.parse(JSON.parse(reply.stdout)),
  );
  assert.ok(
    replies.every((reply): boolean => reply.code === 0 && reply.stderr === ""),
  );
  assert.equal(
    results.filter((reply): boolean => reply.ok && reply.result === true)
      .length,
    1,
  );
  assert.equal(
    results.filter((reply): boolean => reply.ok && reply.result === false)
      .length,
    1,
  );
});

test("runtime reservations use PostgreSQL instead of GitHub and retain live consumers across processes", async (): Promise<void> => {
  const repo = `tests/${crypto.randomUUID()}`;
  const file = config(repo);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, "github-was-called");
  fs.writeFileSync(
    path.join(bin, "gh"),
    "#!/bin/sh\nprintf 'called' > \"$GH_CALLS\"\nexit 1\n",
    { mode: 0o755 },
  );
  const { PATH: inherited = "" } = process.env;
  const env = Object.fromEntries([
    ["PATH", `${bin}${path.delimiter}${inherited}`],
    ["GH_CALLS", calls],
  ]);
  const first = who(repo);
  const holder = await invoke(
    DRIVER,
    {
      config: file,
      issue: first.issue,
      instance: first.instance,
      steps: [
        { do: "reserve", cap: 1 },
        {
          do: "register",
          consumer: { kind: "model-launch", id: "kept-session" },
        },
        { do: "release" },
      ],
    },
    env,
  );
  assert.equal(holder.code, 0, holder.stderr);
  const outcomes = holder.stdout
    .trim()
    .split(NEWLINE)
    .map((line: string) => OUTCOME.parse(JSON.parse(line)));
  assert.equal(outcomes.at(0)?.state, "reserved");
  assert.equal(outcomes.at(-1)?.released, false);
  assert.match(outcomes.at(-1)?.reason ?? "", LIVE);
  const waiter = await invoke(
    DRIVER,
    {
      config: file,
      issue: 2,
      instance: crypto.randomUUID(),
      steps: [{ do: "reserve", cap: 1 }],
    },
    env,
  );
  assert.equal(waiter.code, 0, waiter.stderr);
  const waiting = OUTCOME.parse(JSON.parse(waiter.stdout));
  assert.equal(waiting.state, "waiting");
  assert.match(waiting.reason ?? "", FULL);
  assert.equal(fs.existsSync(calls), false);
  const view = VIEW.parse(
    await executeCoordination(at.db, { ...request(first), operation: "read" }),
  );
  assert.equal(view.owner?.binding.instance, first.instance);
});

test("a reset database takes the same configuration and command without a manual hold", async (): Promise<void> => {
  const binding = who(`tests/${crypto.randomUUID()}`);
  const before = await invoke(relocated, {
    credentialsEnvFile: credentials,
    command: request(binding),
  });
  assert.deepEqual(RESPONSE.parse(JSON.parse(before.stdout)), {
    ok: true,
    result: true,
  });
  const reset = await createTestDatabase();
  const resetCredentials = path.join(dir, "reset.env");
  fs.writeFileSync(resetCredentials, `DATABASE_URL=${reset.url}\n`, {
    mode: PRIVATE_MODE,
  });
  try {
    const rival = who(binding.repo);
    const answered = await invoke(relocated, {
      credentialsEnvFile: resetCredentials,
      command: request(rival),
    });
    assert.deepEqual(RESPONSE.parse(JSON.parse(answered.stdout)), {
      ok: true,
      result: true,
    });
    assert.equal(
      `${answered.stdout}${answered.stderr}`.includes(reset.url),
      false,
    );
  } finally {
    await reset.close();
  }
});

test("database entrypoint refuses public credentials and missing credentials without ambient fallback", async (): Promise<void> => {
  const binding = who(`tests/${crypto.randomUUID()}`);
  const publicFile = path.join(dir, "public.env");
  fs.writeFileSync(publicFile, `DATABASE_URL=${at.url}\n`, {
    mode: WORLD_READABLE,
  });
  fs.chmodSync(publicFile, WORLD_READABLE);
  const publicReply = await invoke(relocated, {
    credentialsEnvFile: publicFile,
    command: request(binding),
  });
  assert.equal(RESPONSE.parse(JSON.parse(publicReply.stdout)).ok, false);
  const missing = await invoke(
    relocated,
    {
      credentialsEnvFile: path.join(dir, "absent.env"),
      command: request(binding),
    },
    Object.fromEntries([["DATABASE_URL", at.url]]),
  );
  const missingResponse = RESPONSE.parse(JSON.parse(missing.stdout));
  assert.equal(missingResponse.ok, false);
  assert.match(missingResponse.reason, UNREADABLE);
  assert.equal(
    `${publicReply.stdout}${publicReply.stderr}${missing.stdout}${missing.stderr}`.includes(
      at.url,
    ),
    false,
  );
});

test("ordinary child environments cannot inherit database credentials", (): void => {
  const clean = childEnvironment(
    Object.fromEntries([
      ["DATABASE_URL", "private-url"],
      ["TEST_DATABASE_URL", "private-test-url"],
      ["PGPASSWORD", "private-password"],
      ["PGPASSFILE", "private-file"],
      ["PGSERVICE", "private-service"],
      ["PGSERVICEFILE", "private-service-file"],
      ["POSTGRES_PASSWORD", "private-container-password"],
      ["PATH", "/bin"],
    ]),
  );
  assert.deepEqual(clean, Object.fromEntries([["PATH", "/bin"]]));
});
