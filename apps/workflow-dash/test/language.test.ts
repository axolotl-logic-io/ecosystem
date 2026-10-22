import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBuddyRuns } from "../buddy-runs.ts";
import { configure, defaults } from "../config.ts";
import { Dashboard } from "../dashboard.ts";
import { Remote } from "../github.ts";
import { executionLabel, stageLabel } from "../language.ts";
import {
  actionTemplates,
  composeInstruction,
  globalTemplates,
} from "../messages.ts";
import { statusPills } from "../status-view.ts";
import { limit, timeBreakdown, timeline } from "../time.ts";
import { workflowRunLabel } from "../workflow-view.ts";
import {
  makeBuddy,
  makeRun,
  makeState,
  viewFixture,
} from "./model-fixtures.ts";
import { getThemeByName } from "./theme-fixtures.ts";

const now = Date.now();
const secondMilliseconds = 1000;
const developerWarningMilliseconds = 2_880_000;
const timeoutTemplateIndex = 2;
const viewSize = { rows: 45, narrow: 40, wide: 220 };
const staleRequestVocabulary = /operator|orchestrator|lane|relaunch\/resume/u;
const oldPaneVocabulary = /Operators|Jobs|Pipeline|PIPELINE/u;
const run = makeRun(
  {
    id: "source-run-id",
    stage: "implement",
    startedAt: now - secondMilliseconds,
    launches: [
      {
        key: "implementor-1",
        kind: "session",
        startedAt: now - secondMilliseconds,
      },
    ],
  },
  { repo: "org/repo", issue: 2 },
);
const panes = [
  { tab: 0, name: "Workflow runs" },
  { tab: 1, name: "Issues" },
  { tab: 2, name: "Buddy runs" },
  { tab: 3, name: "Time" },
];

test("canonical labels do not rewrite recorded launch keys or source stages", () => {
  assert.equal(executionLabel("implementor-1"), "developer-1");
  assert.equal(executionLabel("implementor"), "developer");
  assert.equal(executionLabel("implementor-other-2"), "developer-other-2");
  for (const key of [
    "developer-1",
    "reviewer-1",
    "verify-1",
    "not-implementor-1",
    "implementors-1",
  ]) {
    assert.equal(executionLabel(key), key);
  }
  assert.equal(stageLabel("implement"), "Implementation");
  assert.equal(stageLabel("review"), "Hardening");
  assert.equal(stageLabel("merge"), "Legacy merge");
  assert.equal(stageLabel("future-stage"), "future-stage");
  assert.equal(timeline(run, now)[0].key, "implementor-1");
  assert.equal(run.data.stage, "implement");
  assert.equal(run.data.id, "source-run-id");
  assert.ok(workflowRunLabel(run).includes("Implementation developer-1"));
  assert.ok(
    Object.hasOwn(timeBreakdown([run], now).launches, "session/developer"),
  );
  assert.equal(run.data.launches[0].key, "implementor-1");
  assert.deepEqual(
    limit("developer-1", 0, developerWarningMilliseconds),
    limit("implementor-1", 0, developerWarningMilliseconds),
  );
});
test("buddyRuns config wins over the deprecated operators key and both expand home", () => {
  assert.equal(
    configure({ buddyRuns: "~/new-runs" }).buddyRuns,
    join(homedir(), "new-runs"),
  );
  assert.equal(
    configure({ operators: "~/old-runs" }).buddyRuns,
    join(homedir(), "old-runs"),
  );
  assert.equal(
    configure({ buddyRuns: "~/new-runs", operators: "~/old-runs" }).buddyRuns,
    join(homedir(), "new-runs"),
  );
  assert.equal(
    configure({ buddyRuns: 3, operators: "~/old-runs" }).buddyRuns,
    join(homedir(), "old-runs"),
  );
  assert.equal(
    configure({ buddyRuns: 3, operators: false }).buddyRuns,
    defaults.buddyRuns,
  );
  assert.equal(
    Object.hasOwn(configure({ operators: "~/old-runs" }), "operators"),
    false,
  );
});
test("renamed buddy loader reads the same records and keeps today-only coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "dash-buddy-runs-"));
  try {
    await mkdir(join(root, "agent-run-id"));
    await writeFile(
      join(root, "agent-run-id", "status.json"),
      JSON.stringify({
        state: "complete",
        startedAt: "2000-01-01T00:00:00Z",
        task: "fixture task",
      }),
    );
    const config = configure({ operators: root });
    assert.deepEqual(await loadBuddyRuns(config), []);
    const runs = await loadBuddyRuns(config, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "agent-run-id");
    assert.equal(runs[0].mission, "fixture task");
    assert.equal(runs[0].state, "complete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("request templates preserve checkpoints, retry linkage and resource holds", async () => {
  const templates = actionTemplates({ kind: "workflow", run });
  for (const phrase of [
    "retry as a new linked run",
    "latest kept checkpoint",
    "preserve task/binding attempt budgets",
    "run source-run-id",
    "source stage implement",
  ]) {
    assert.ok(templates[0].includes(phrase));
  }
  assert.ok(
    templates[timeoutTemplateIndex].includes("retry as a new linked run"),
  );
  assert.ok(
    templates[timeoutTemplateIndex].includes(
      "reconcile uncertain writes before retrying",
    ),
  );
  assert.ok(
    actionTemplates({
      kind: "buddy",
      run: makeBuddy({ id: "agent-run-id" }),
    }).every((text) => text.includes("buddy run agent-run-id")),
  );
  const global = globalTemplates.at(-1);
  assert.ok(global);
  assert.ok(global.includes("configured resource caps"));
  assert.ok(global.includes("unknown resource ownership stays held"));
  assert.equal(
    staleRequestVocabulary.test(
      JSON.stringify([...templates, ...globalTemplates]),
    ),
    false,
  );
  let editorTitle = "";
  await composeInstruction(
    {
      sendUserMessage: (): never => {
        throw new Error("Cancellation must not send");
      },
    },
    {
      ui: {
        editor: (title: string) => {
          editorTitle = title;
          return Promise.resolve(undefined);
        },
      },
      isIdle: () => true,
    },
    "template",
  );
  assert.ok(editorTitle.startsWith("Tell the caller"));
});
for (const name of ["dark", "light"]) {
  const theme = getThemeByName(name);
  for (const pane of panes) {
    test(`${name}: canonical ${pane.name} pane renders at narrow and wide widths`, () => {
      const state = makeState({
        workflowRuns: [run],
        buddyRuns: [makeBuddy({ id: "agent-run-id", start: now })],
      });
      const view = viewFixture(viewSize.rows);
      const dashboard = new Dashboard(view.host, {
        theme,
        get: () => state,
        remote: new Remote(defaults),
        getTime: () => "Session timestamp deltas",
        done: view.done,
      });
      dashboard.navigation.tab = pane.tab;
      dashboard.navigation.rebuild();
      assert.ok(
        dashboard.render(viewSize.narrow).join("\n").includes(pane.name),
      );
      const screen = dashboard.render(viewSize.wide).join("\n");
      assert.ok(screen.includes("Workflow runs"));
      assert.ok(screen.includes("Buddy runs"));
      assert.equal(oldPaneVocabulary.test(screen), false);
    });
  }
  test(`${name}: mapped task labels remain distinct from source records`, () => {
    const state = makeState({ workflowRuns: [run] });
    const view = viewFixture(viewSize.rows);
    const dashboard = new Dashboard(view.host, {
      theme,
      get: () => state,
      remote: new Remote(defaults),
      getTime: () => "",
      done: view.done,
    });
    const screen = dashboard.render(viewSize.wide).join("\n");
    assert.ok(screen.includes("Implementation"));
    assert.ok(screen.includes("developer-1"));
    assert.ok(screen.includes("Source stage: implement"));
    const pills = statusPills(state, theme);
    assert.ok(pills.includes("processes 1 observed"));
    assert.ok(pills.includes("configured caps unknown"));
  });
}
