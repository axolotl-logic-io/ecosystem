import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { MonitorSnapshot } from "@ecosystem/db/monitoring";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { notices, workRows } from "../../monitor/model.ts";
import { entity, projectRecord, redact } from "../../monitor/records.ts";
import { MonitorView, type MonitorViewOptions } from "../../monitor/view.ts";

const screen = { rows: 30, wide: 120 };
const expected = { context: 150, output: 30 };
const longReasonRepeats = 40;
const time = "2026-10-28T12:00:00.000Z";
const repo = "axolotl-logic-io/project-buddy";
const now = Date.parse(time);
function snapshot(entities: MonitorEntity[]): MonitorSnapshot {
  return { entities, usage: [], at: time, partial: false };
}
function work(): MonitorEntity {
  return entity({
    id: "issue",
    kind: "work",
    repo,
    issue: 541,
    title: "Sort tests 界",
    state: "open",
    sourceAt: time,
  });
}
function action(state: string, task = "implement"): MonitorEntity {
  const result = entity({
    id: "action",
    kind: "action",
    repo,
    issue: 541,
    title: "Implement",
    state,
    task,
    sourceAt: time,
    startedAt: time,
  });
  if (state !== "running") {
    result.endedAt = time;
  }
  return result;
}
// A theme that leaves text unstyled, so assertions read plain text.
const plainTheme: MonitorViewOptions["theme"] = {
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
  style: (text: string): string => text,
  colors: new Proxy<MonitorViewOptions["theme"]["colors"]>(
    {},
    {
      get: (): { kind: "rgb"; r: number; g: number; b: number } => ({
        kind: "rgb",
        r: 0,
        g: 0,
        b: 0,
      }),
    },
  ),
};
function viewModel(state: MonitorSnapshot): MonitorViewOptions {
  return {
    repositories: [repo, "axolotl-logic-io/ecosystem"],
    done: (): void => {
      /* The fixture does not close the surrounding terminal. */
    },
    theme: plainTheme,
    runtime: {
      snapshot: state,
      error: null,
      session: null,
      following: true,
      page: { rows: [], more: false },
      refresh: (): Promise<void> => Promise.resolve(),
      loadPage: (): Promise<void> => Promise.resolve(),
    },
  };
}

test("an open issue with a start label is pending, not an authorized ready task", (): void => {
  const item = { ...work(), reason: "start:implement requested" };
  const [row] = workRows(snapshot([item]), null, now);
  assert.equal(row?.section, "PENDING");
  assert.equal(row?.state, "Awaiting start");
});

test("task completion is distinct from issue completion and a failed attempt needs attention", (): void => {
  assert.equal(
    workRows(snapshot([work(), action("succeeded")]), null, now).at(0)?.section,
    "PENDING",
  );
  assert.equal(
    workRows(snapshot([work(), action("succeeded", "land")]), null, now).at(0)
      ?.state,
    "Landed",
  );
  assert.equal(
    workRows(snapshot([work(), action("failed")]), null, now).at(0)?.section,
    "NEEDS YOU",
  );
  assert.equal(
    workRows(snapshot([work(), action("running")]), "other/repo", now).length,
    0,
  );
});

test("final messages alone add turn usage and output is excluded from context", (): void => {
  const message = {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "Visible reasoning",
        thinkingSignature: "opaque replay data",
      },
      { type: "text", text: "A response" },
    ],
    usage: {
      input: 100,
      output: 30,
      cacheRead: 40,
      cacheWrite: 10,
      reasoning: 20,
    },
  };
  assert.equal(
    projectRecord(
      { type: "message_update", usage: message.usage },
      "s",
      "f",
      0,
    ),
    null,
  );
  const event = projectRecord({ type: "message_end", message }, "s", "f", 1);
  assert.equal(event?.context, expected.context);
  assert.equal(event?.usage?.output, expected.output);
  assert.equal(event?.reasoning, "Visible reasoning");
  assert.equal(event?.body, "A response");
  assert.ok(!JSON.stringify(event).includes("opaque replay data"));
});

test("nested model usage and compaction usage contribute without pretending to be context", (): void => {
  const usage = { input: 40, output: 5, cacheRead: 0, cacheWrite: 0 };
  const tool = projectRecord(
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolName: "review",
        content: "done",
        usage,
      },
    },
    "s",
    "f",
    0,
  );
  const compact = projectRecord(
    { type: "compaction_end", result: { summary: "A summary", usage } },
    "s",
    "f",
    1,
  );
  assert.deepEqual(tool?.usage, usage);
  assert.equal(tool?.context, null);
  assert.equal(compact?.compacted, true);
  assert.deepEqual(compact?.usage, usage);
  assert.equal(compact?.context, null);
});

test("credentials and terminal control sequences never become transcript content", (): void => {
  const credential = "example-value-not-a-real-key";
  const redacted = redact(
    `password=${credential}\nAuthorization: Bearer ${credential}\npostgres://user:${credential}@localhost/database\n\u001b]0;untrusted title\u0007`,
  );
  assert.ok(!redacted.includes(credential));
  assert.ok(!redacted.includes("\u001b"));
  assert.ok(!redacted.includes("\u0007"));
  const event = projectRecord(
    {
      type: "tool_execution_end",
      toolName: "read",
      result: {
        content: [{ type: "text", text: `model-key.env ${credential}` }],
      },
    },
    "s",
    "f",
    0,
  );
  assert.ok(!event?.body.includes(credential));
});

test("the combined view fills the terminal, fits narrow widths and does not present missing usage as zero", (): void => {
  const options = viewModel(snapshot([work(), action("running")]));
  const view = new MonitorView(
    {
      terminal: { rows: 30 },
      requestRender: (): void => {
        /* No terminal renderer in this component test. */
      },
    },
    options,
  );
  for (const width of [24, 60, screen.wide]) {
    const lines = view.render(width);
    assert.ok(lines.every((line): boolean => visibleWidth(line) <= width));
    // Exactly the terminal's height, so the overlay hides the conversation behind it.
    assert.equal(lines.length, screen.rows);
  }
  const text = view.render(screen.wide).join("\n");
  assert.ok(text.includes("ctx — · tokens —"));
  assert.ok(!text.includes("observed"));
  assert.ok(text.includes("Sort tests"));
});

test("session messages and exposed reasoning expand read-only and scrolling pauses following", (): void => {
  const session = entity({
    id: "standalone",
    kind: "session",
    title: "A subagent",
    state: "running",
    sourceAt: time,
  });
  const event = projectRecord(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "A response" },
          { type: "thinking", thinking: "Visible reasoning" },
        ],
      },
    },
    session.id,
    "stream",
    0,
  );
  assert.ok(event);
  const options = viewModel(snapshot([session]));
  let requested: string | null = null;
  options.runtime.loadPage = (id: string): Promise<void> => {
    requested = id;
    options.runtime.page = { rows: [{ sequence: 1, event }], more: false };
    return Promise.resolve();
  };
  const view = new MonitorView(
    {
      terminal: { rows: 30 },
      requestRender: (): void => {
        /* Render is driven directly. */
      },
    },
    options,
  );
  view.render(screen.wide);
  view.handleInput("\r");
  assert.equal(requested, session.id);
  view.render(screen.wide);
  view.handleInput("\r");
  assert.ok(view.render(screen.wide).join("\n").includes("Visible reasoning"));
  assert.equal(options.runtime.following, false);
  view.handleInput("\u001b[F");
  assert.equal(options.runtime.following, true);
});

test("a failed turn's all-zero usage is unmeasured, not an empty context", (): void => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const event = projectRecord(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: zero,
        errorMessage: "stream ended",
      },
    },
    "s",
    "f",
    0,
  );
  assert.equal(event?.kind, "error");
  assert.ok(event?.label.endsWith("failed"));
  assert.equal(event?.usage, null);
  assert.equal(event?.context, null);
});

test("each collector warning is its own notice and long reasons stay on one list line", (): void => {
  const collector = entity({
    id: "collector",
    kind: "health",
    title: "Monitoring",
    state: "partial",
    reason: "First warning\nSecond warning",
    sourceAt: time,
  });
  assert.deepEqual(notices(snapshot([collector]), null), [
    "First warning",
    "Second warning",
  ]);
  const failed = {
    ...action("failed"),
    reason: `${"rate limit ".repeat(longReasonRepeats)}\nrequest details`,
  };
  const view = new MonitorView(
    {
      terminal: { rows: screen.rows },
      requestRender: (): void => {
        /* Render is driven directly. */
      },
    },
    viewModel(snapshot([work(), failed, collector])),
  );
  const text = view.render(screen.wide).join("\n");
  assert.ok(text.includes("NOTICES · 2"));
  assert.ok(!text.includes("request details"));
  assert.ok(text.includes("implement failed"));
});
