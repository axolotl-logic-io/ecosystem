// The integration-source tests' isolation: before anything from src/ loads,
// a temporary HOME and pi agent folder, a fixed git identity, and the ops
// fixture's temporary pipeline root (ops-fixtures.ts), which it checks is the
// root src/ reads. No test of these files reaches the real home or root.
import fs from "node:fs";
import process from "node:process";
import type { OpsFixture } from "./ops-fixtures.ts";
import { opsFixture } from "./ops-fixtures.ts";
import { setEnv } from "./ops-run-test-kit.ts";

const TEMPORARY_PREFIX = "/tmp/issue-pipeline-";
const GIT_IDENTITY: readonly [string, string][] = [
  ["GIT_AUTHOR_NAME", "pipeline test"],
  ["GIT_AUTHOR_EMAIL", "pipeline-test@example.invalid"],
  ["GIT_COMMITTER_NAME", "pipeline test"],
  ["GIT_COMMITTER_EMAIL", "pipeline-test@example.invalid"],
];

// The ops fixture named `name`, with HOME, PI_CODING_AGENT_DIR and the git
// identity set first; throws unless src/ reads the fixture's temporary root.
async function isolatedOpsFixture(name: string): Promise<OpsFixture> {
  const home = fs.mkdtempSync(`${TEMPORARY_PREFIX}${name}-home-`);
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
  setEnv("HOME", home);
  setEnv("PI_CODING_AGENT_DIR", `${home}/agent`);
  setEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const [variable, value] of GIT_IDENTITY) {
    setEnv(variable, value);
  }
  const fx = await opsFixture(name);
  const { ROOT } = await import("../src/pipeline-root.ts");
  if (ROOT !== fx.root || !ROOT.startsWith(TEMPORARY_PREFIX)) {
    throw new Error(`src/ reads the pipeline root ${ROOT}, not ${fx.root}`);
  }
  return fx;
}

export { isolatedOpsFixture };
