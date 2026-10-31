import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { DashboardExtension } from "../../extension.ts";
import type { DashboardContext } from "../../host.ts";
import extension from "../../index.ts";
import { extensionHost } from "../support/extension-test-kit.ts";

const flagsOnly = ["flag:workflow-dash"];
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
    const host = extensionHost(mode, { "workflow-dash": flag });
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

test("an invalid configuration is refused and leaves the dashboard inactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-dash-config-"));
  try {
    const config = join(root, "workflow-dash.json");
    await writeFile(
      config,
      JSON.stringify({ repos: ["fixture-org/fixture-repo"], unknown: true }),
    );
    const host = extensionHost("tui", { "workflow-dash": true });
    new DashboardExtension(host.api, config).install();
    const start = host.handlers.get("session_start");
    assert.ok(start);
    await Promise.resolve(start({}, host.context));
    assert.deepEqual(host.events, [...tuiRegistrations, "notify"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
