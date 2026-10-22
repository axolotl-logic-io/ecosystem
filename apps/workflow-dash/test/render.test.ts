import assert from "node:assert/strict";
import { test } from "node:test";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { defaults } from "../config.ts";
import { Dashboard } from "../dashboard.ts";
import { Remote } from "../github.ts";
import { Pager } from "../pager.ts";
import { widget } from "../status-view.ts";
import {
  makeBuddy,
  makeRun,
  makeState,
  viewFixture,
} from "./model-fixtures.ts";
import { getThemeByName } from "./theme-fixtures.ts";

const widths = {
  narrow: 40,
  standard: 80,
  split: 110,
  wide: 160,
  extraWide: 220,
};
const runCounts = { empty: 0, full: 4 };
const stress = {
  workflowAge: 99_999_999,
  launchAge: 9_999_999,
  missionCharacters: 100,
  titleCharacters: 200,
  pagerRepeats: 500,
  timeLines: 200,
};
const widgetHeight = { minimum: 2, maximum: 5 };
const fixtureIssue = 499;
const shaLength = 40;
const now = Date.now();
const stages = ["author", "implement", "review", "merge"];
const panes = [
  { tab: 0, name: "workflow" },
  { tab: 1, name: "issues" },
  { tab: 2, name: "buddies" },
  { tab: 3, name: "time" },
];
const sourceRun = makeRun(
  {
    stage: "review",
    startedAt: now - stress.workflowAge,
    launches: [
      {
        key: "reviewer-1",
        startedAt: now - stress.launchAge,
        kind: "session",
        usage: { input: 3000 },
      },
    ],
  },
  { repo: "org/project-buddy", issue: fixtureIssue },
);
const remote = new Remote(defaults);
remote.issues = [
  {
    repo: "org/ecosystem",
    number: 4,
    title: "界".repeat(stress.titleCharacters),
    labels: [{ name: "agent:review" }],
  },
];
remote.prs = [
  {
    repo: "org/ecosystem",
    number: 5,
    title: "PR",
    headRefOid: "abcdef",
    state: "OPEN",
  },
];
for (const themeName of ["dark", "light"]) {
  for (const count of Object.values(runCounts)) {
    for (const hold of [false, true]) {
      for (const width of Object.values(widths)) {
        test(`${themeName}: ${count} workflow runs hold=${hold}, all panes fit ${width}`, () => {
          const theme = getThemeByName(themeName);
          const view = viewFixture();
          const state = makeState({
            hold,
            installed: "a".repeat(shaLength),
            main: "b".repeat(shaLength),
            workflowRuns: Array.from({ length: count }, (_, index) =>
              makeRun(
                { ...sourceRun.data, stage: stages.at(index) },
                { ...sourceRun, issue: fixtureIssue + index },
              ),
            ),
            buddyRuns: [
              makeBuddy({
                id: "agent-run",
                mission: "界".repeat(stress.missionCharacters),
                start: now,
                last: now,
                pending: "unknown",
                tail: "wide 界 ".repeat(stress.missionCharacters),
              }),
            ],
          });
          const status = widget(() => state, theme);
          const pager = new Pager(view.host, {
            text: "Untrusted data 界".repeat(stress.pagerRepeats),
            title: "Thread",
            done: view.close,
            theme,
            workflowRun: true,
          });
          const components: Component[] = [status, pager];
          for (const pane of panes) {
            const dash = new Dashboard(view.host, {
              theme,
              get: () => state,
              remote,
              getTime: () => "Time 界\n".repeat(stress.timeLines),
              done: view.done,
            });
            dash.navigation.tab = pane.tab;
            dash.navigation.rebuild();
            components.push(dash);
          }
          for (const component of components) {
            component.invalidate();
            const lines = component.render(width);
            assert.ok(lines.length > 0);
            for (const line of lines) {
              assert.ok(
                visibleWidth(line) <= width,
                `${visibleWidth(line)} > ${width}: ${line}`,
              );
            }
          }
          assert.ok(status.render(width).length >= widgetHeight.minimum);
          assert.ok(status.render(width).length <= widgetHeight.maximum);
        });
      }
    }
  }
}
