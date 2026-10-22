import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { type DashboardContext, enabled } from "../host.ts";
import extension from "../index.ts";
import { extensionHost } from "./extension-test-kit.ts";

const flagsOnly = ["flag:workflow-dash", "flag:pipeline-dash"];
const tuiRegistrations: string[] = [...flagsOnly, "command:dash", "shortcut"];
const inactiveCases: {
  mode: DashboardContext["mode"];
  flag: boolean | undefined;
  expected: string[];
}[] = [
  { mode: "tui", flag: false, expected: tuiRegistrations },
  { mode: "tui", flag: undefined, expected: tuiRegistrations },
  { mode: "rpc", flag: true, expected: flagsOnly },
  { mode: "print", flag: true, expected: flagsOnly },
  { mode: "json", flag: true, expected: flagsOnly },
];
for (const { mode, flag, expected } of inactiveCases) {
  test(`${mode} flag=${flag}: inactive lifecycle performs no collection or UI work`, async () => {
    const host = extensionHost(mode, {
      "workflow-dash": flag,
      "pipeline-dash": flag,
    });
    extension(host.api);
    assert.deepEqual(host.events, flagsOnly);
    assert.deepEqual(
      [...host.handlers.keys()],
      ["session_start", "session_shutdown"],
    );
    const before = process
      .getActiveResourcesInfo()
      .filter((resource) => resource === "Timeout").length;
    const start = host.handlers.get("session_start");
    const shutdown = host.handlers.get("session_shutdown");
    assert.ok(start);
    assert.ok(shutdown);
    await Promise.resolve(start({}, host.context));
    assert.deepEqual(host.events, expected);
    await Promise.resolve(shutdown({}, host.context));
    await Promise.resolve(shutdown({}, host.context));
    assert.deepEqual(host.events, expected);
    assert.equal(
      process
        .getActiveResourcesInfo()
        .filter((resource) => resource === "Timeout").length,
      before,
    );
  });
}
test("opt-in gating is strict and mode-specific", () => {
  for (const mode of ["rpc", "print", "json"]) {
    assert.equal(enabled(mode, true), false);
  }
  assert.equal(enabled("tui", true), true);
  for (const flag of [false, undefined, "true", 1]) {
    assert.equal(enabled("tui", flag), false);
  }
});
