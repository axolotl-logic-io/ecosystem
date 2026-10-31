import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type DatabaseConnection, openDatabase } from "@ecosystem/db";
import { readSnapshot, transcript } from "@ecosystem/db/monitoring";
import { createTestDatabase, type TestDatabase } from "@ecosystem/db/testing";
import { configure } from "../../config.ts";
import {
  collectIssues,
  collectMonitoring,
  ingestStream,
} from "../../monitor/collector.ts";
import { monitoringConnection } from "../../monitor/connection.ts";
import { MonitorRuntime } from "../../monitor/runtime.ts";
import { repo, writeRecord, writeText } from "../support/task-run-fixtures.ts";

const permissions = { public: 0o644 };
const at: TestDatabase = await createTestDatabase();
const root: string = await mkdtemp(join(tmpdir(), "workflow-monitor-test-"));
after(async (): Promise<void> => {
  await at.close();
  await rm(root, { recursive: true, force: true });
});
const usage = { input: 100, output: 20, cacheRead: 40, cacheWrite: 10 };
function messageRecord(text: string): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "thinking", thinking: "Provider-exposed thought" },
      ],
      usage,
    },
  };
}
function message(text: string): string {
  return JSON.stringify(messageRecord(text));
}

test("append-only collection preserves UTF-8, waits for complete lines and does not recount replay", async (): Promise<void> => {
  const path = join(root, "stream.jsonl");
  const first = `${message("界\u2028A response")}\n`;
  const second = message("Another response");
  await writeFile(path, first + second);
  const options = { root, session: (): string => "stream-session" };
  assert.equal(await ingestStream(at.db, path, options), true);
  assert.equal((await transcript(at.db, "stream-session")).rows.length, 1);
  await ingestStream(at.db, path, options);
  assert.equal((await transcript(at.db, "stream-session")).rows.length, 1);
  await appendFile(path, "\n");
  assert.equal(await ingestStream(at.db, path, options), false);
  const { rows } = await transcript(at.db, "stream-session");
  assert.equal(rows.length, 2);
  assert.equal(rows.at(0)?.event.body, "界\u2028A response");
  assert.equal(rows.at(1)?.event.reasoning, "Provider-exposed thought");
  await writeFile(path, "");
  await assert.rejects(ingestStream(at.db, path, options));
  assert.equal((await transcript(at.db, "stream-session")).rows.length, 2);
});

test("transcript symlinks and escaped source roots are refused", async (): Promise<void> => {
  const path = join(root, "linked.jsonl");
  const target = join(root, "target.jsonl");
  await writeFile(target, `${message("private output")}\n`);
  await symlink(target, path);
  await assert.rejects(
    ingestStream(at.db, path, { root, session: (): string => "linked" }),
  );
  const nested = join(root, "nested");
  await mkdir(nested);
  await assert.rejects(
    ingestStream(at.db, target, {
      root: nested,
      session: (): string => "escaped",
    }),
  );
  assert.equal((await transcript(at.db, "linked")).rows.length, 0);
});

test("the collector imports generic subagent runs as standalone sessions", async (): Promise<void> => {
  const generic = join(root, "generic");
  const genericId = "generic-run";
  await writeRecord(join(generic, genericId, "status.json"), {
    id: genericId,
    state: "complete",
    startedAt: Date.now(),
    endedAt: Date.now(),
    steps: [{ index: 0, agent: "reviewer", status: "complete" }],
  });
  const event = {
    ...messageRecord("Generic reply"),
    subagentRunId: genericId,
    subagentStepIndex: 0,
  };
  await writeText(
    join(generic, genericId, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
  const config = configure({ repos: [repo], subagentRuns: generic });
  await collectMonitoring(at.db, config, join(root, "runs"), false);
  const snapshot = await readSnapshot(at.db, [repo]);
  assert.equal(
    snapshot.entities.find(
      (row): boolean => row.id === `subagent:${genericId}:0`,
    )?.parent,
    null,
  );
  assert.equal(
    (await transcript(at.db, `subagent:${genericId}:0`)).rows.at(0)?.event.body,
    "Generic reply",
  );
});

test("GitHub synchronization keeps an issue's workflow labels, and a failure retains work and stays visible", async (): Promise<void> => {
  const config = configure({
    repos: [repo],
    subagentRuns: join(root, "generic"),
  });
  const warnings: string[] = [];
  await collectIssues(
    at.db,
    config,
    warnings,
    (_repo: string, state: string): Promise<unknown> => {
      if (state === "closed") {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          number: 42,
          title: "Queued work",
          state: "OPEN",
          updatedAt: new Date().toISOString(),
          closedAt: null,
          labels: [
            { name: "start:gherkin" },
            { name: "agent:implement:running" },
            { name: "agents:stop" },
            { name: "bug" },
          ],
        },
      ]);
    },
  );
  await collectIssues(
    at.db,
    config,
    warnings,
    (): Promise<unknown> => Promise.reject(new Error("A failed read")),
  );
  await collectMonitoring(at.db, config, join(root, "runs"), false);
  const snapshot = await readSnapshot(at.db, [repo]);
  const issue = snapshot.entities.find(
    (row): boolean => row.id === `${repo}#42`,
  );
  assert.equal(issue?.state, "open");
  assert.equal(
    issue?.reason,
    "start:gherkin · agent:implement:running · agents:stop",
  );
  assert.equal(
    snapshot.entities.find((row): boolean => row.id === `github:${repo}:open`)
      ?.state,
    "failed",
  );
});

test("monitoring credential files require owner-only permissions and failures do not leak URLs", async (): Promise<void> => {
  const path = join(root, "reader.env");
  await writeFile(path, `DATABASE_URL=${at.url}\n`, { mode: 0o600 });
  const connection = await monitoringConnection("reader", path);
  await connection.close();
  await chmod(path, permissions.public);
  await assert.rejects(
    monitoringConnection("reader", path),
    (error: unknown): boolean =>
      error instanceof Error &&
      !String(error).includes(at.url) &&
      error.cause === undefined,
  );
});

test("a stopped runtime closes a late connection instead of publishing stale data", async (): Promise<void> => {
  const connection = openDatabase(at.url);
  let deliver: ((value: DatabaseConnection) => void) | undefined;
  const pending = new Promise<DatabaseConnection>((resolve): void => {
    deliver = resolve;
  });
  let requested: (() => void) | undefined;
  const opened = new Promise<void>((resolve): void => {
    requested = resolve;
  });
  const runtime = new MonitorRuntime((): Promise<DatabaseConnection> => {
    requested?.();
    return pending;
  });
  const started = runtime.start(configure({ repos: [repo] }));
  await opened;
  await runtime.stop();
  deliver?.(connection);
  await started;
  assert.equal(runtime.snapshot, null);
  assert.equal(runtime.error, null);
});
