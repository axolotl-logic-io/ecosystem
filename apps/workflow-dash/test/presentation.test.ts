import assert from "node:assert/strict";
import { test } from "node:test";
import { Pager } from "../pager.ts";
import { statusPills, widget } from "../status-view.ts";
import { progress } from "../ui-format.ts";
import { makeBuddy, makeState, viewFixture } from "./model-fixtures.ts";
import { getThemeByName } from "./theme-fixtures.ts";

const sizes = { bar: 8, wide: 160, compact: 90, rows: 30 };
const thresholds: {
  ratio: number;
  filled: number;
  ink: "success" | "warning" | "error";
}[] = [
  { ratio: 0.5, filled: 4, ink: "success" },
  { ratio: 0.8, filled: 6, ink: "warning" },
  { ratio: 1.01, filled: 8, ink: "error" },
];
for (const name of ["dark", "light"]) {
  test(`${name}: progress thresholds retain their colors`, () => {
    const theme = getThemeByName(name);
    for (const point of thresholds) {
      assert.ok(
        progress(theme, point.ratio, sizes.bar).includes(
          theme.fg(point.ink, "▰".repeat(point.filled)),
        ),
      );
    }
  });
  test(`${name}: version changes render and unknown requests remain silent`, () => {
    const theme = getThemeByName(name);
    const state = makeState({
      hold: true,
      installed: "abc1234",
      main: "abc1234",
      buddyRuns: [makeBuddy({ pending: "unknown" })],
    });
    const pills = statusPills(state, theme);
    assert.ok(pills.includes("HOLD"));
    assert.ok(pills.includes("= main"));
    assert.ok(pills.includes("configured caps unknown"));
    assert.equal(pills.includes("requests"), false);
    const status = widget(() => state, theme);
    const first = status.render(sizes.wide);
    status.invalidate();
    assert.deepEqual(status.render(sizes.wide), first);
    state.main = "bbb1234";
    assert.ok(status.render(sizes.compact)[0].includes("≠ main"));
    const view = viewFixture(sizes.rows);
    const pager = new Pager(view.host, {
      text: "ℹ pass 4\nℹ fail 2",
      title: "Verification",
      done: view.close,
      theme,
      workflowRun: true,
    });
    const rendered = pager.render(sizes.compact).join("\n");
    assert.ok(
      rendered.includes(
        `${theme.fg("success", "MARK").split("MARK")[0]}ℹ pass 4`,
      ),
    );
    assert.ok(
      rendered.includes(
        `${theme.fg("error", "MARK").split("MARK")[0]}ℹ fail 2`,
      ),
    );
  });
}
