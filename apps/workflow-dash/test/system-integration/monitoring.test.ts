import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { dirname, join } from "node:path";
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
import {
  actionRun,
  actionRunPath,
  buddyRun,
  buddyRunPath,
  repo,
  writeObservation,
  writeText,
} from "../runtime-run-fixtures.ts";

const issueNumber = 541;
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

test("the collector imports explicit pipeline session parents and generic step identities", async (): Promise<void> => {
  const runs = join(root, "runs");
  const generic = join(root, "generic");
  const buddy = crypto.randomUUID();
  const action = crypto.randomUUID();
  const session = crypto.randomUUID();
  const path = actionRunPath(runs, issueNumber, action);
  const startedAt = new Date().toISOString();
  const observation = actionRun(action, buddy, issueNumber, {
    state: "ended",
    outcome: "succeeded",
    verdict: "passed",
    ownership: { state: "released", reason: null },
    sessions: [
      {
        id: session,
        parent: action,
        key: "developer",
        agent: "developer",
        model: "test/model",
        phase: null,
        commits: false,
        pid: null,
        reservation: null,
        startedAt,
        endedAt: startedAt,
        outcome: "ok",
      },
    ],
  });
  await writeObservation(
    buddyRunPath(runs, buddy),
    buddyRun(buddy, { state: "stopped" }),
  );
  await writeObservation(path, observation);
  await writeText(
    join(dirname(path), "sessions/developer.jsonl"),
    `${message("Pipeline reply")}\n`,
  );
  const genericId = "generic-run";
  await writeObservation(join(generic, genericId, "status.json"), {
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
  const config = configure({ repos: [repo], runs, subagentRuns: generic });
  await collectMonitoring(at.db, config, false);
  await collectMonitoring(at.db, config, false);
  const snapshot = await readSnapshot(at.db, [repo]);
  assert.equal(
    snapshot.entities.find((row): boolean => row.id === session)?.parent,
    action,
  );
  assert.equal(
    snapshot.entities.find(
      (row): boolean => row.id === `subagent:${genericId}:0`,
    )?.parent,
    null,
  );
  assert.equal(
    snapshot.usage.find((row): boolean => row.session === session)?.input,
    usage.input,
  );
  assert.equal(
    (await transcript(at.db, `subagent:${genericId}:0`)).rows.at(0)?.event.body,
    "Generic reply",
  );
});

test("GitHub synchronization failures retain work and remain visible between syncs", async (): Promise<void> => {
  const config = configure({
    repos: [repo],
    runs: join(root, "runs"),
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
          labels: [{ name: "start:author" }],
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
  await collectMonitoring(at.db, config, false);
  const snapshot = await readSnapshot(at.db, [repo]);
  assert.equal(
    snapshot.entities.find((row): boolean => row.id === `${repo}#42`)?.state,
    "open",
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
