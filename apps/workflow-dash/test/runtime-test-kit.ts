import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type Config, configure } from "../config.ts";
import { Remote } from "../github.ts";
import { DashboardRuntime, type RuntimeSources } from "../runtime.ts";
import { type ExtensionHost, extensionHost } from "./extension-test-kit.ts";

const shaLength = 40;
interface RuntimeFixture {
  runtime: DashboardRuntime;
  host: ExtensionHost;
  configPath: string;
}
async function runtimeFixture(
  context: TestContext,
  snapshot: RuntimeSources["snapshot"],
): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), "workflow-dash-runtime-"));
  const host = extensionHost("tui");
  const runtime = new DashboardRuntime({
    snapshot,
    remote: (sourceConfig: Config): Remote =>
      new Remote(sourceConfig, () =>
        Promise.resolve({ stdout: "a".repeat(shaLength) }),
      ),
  });
  context.after(async () => {
    runtime.stop();
    await rm(root, { recursive: true, force: true });
  });
  const config = configure({
    runs: join(root, "runs"),
    buddyRuns: join(root, "buddies"),
    installed: join(root, "installed.json"),
    hold: join(root, "hold"),
    plan: join(root, "plan.md"),
    repos: [],
    mainRepo: "fixture/repo",
  });
  const configPath = join(root, "workflow-dash.json");
  await writeFile(configPath, JSON.stringify(config));
  return { runtime, host, configPath };
}

export type { RuntimeFixture };
export { runtimeFixture };
