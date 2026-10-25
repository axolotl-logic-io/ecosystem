// A loaded pipeline config for tests of the modules that take one, written to
// a temporary file, with the warnings loadConfig printed while loading it.
// A test isolates the pipeline root first (isolated-root-test-kit.ts or its
// own kit) and imports this kit dynamically after it; the kit refuses to load
// unless src's root is that temporary root.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { Config } from "../src/config.ts";
import { credentialConfig } from "./credentials-test-kit.ts";

const { ROOT }: typeof import("../src/pipeline-root.ts") = await import(
  "../src/pipeline-root.ts"
);
const { ISSUE_PIPELINE_ROOT: isolated }: NodeJS.ProcessEnv = process.env;
if (isolated === undefined || ROOT !== isolated || !fs.existsSync(ROOT)) {
  throw new Error("config-test-kit loaded before the test isolated its root");
}
const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);

const BASE: {
  allowedUsers: string[];
  commands: { test: string };
  devAccount: string;
  mergeAccount: string;
  credentialsEnvFile: string;
  repo: string;
} = {
  repo: "example/repo",
  ...credentialConfig("pipeline-bot"),
  allowedUsers: ["owner"],
  commands: { test: "true" },
};

// extra: keys over the base config
function testConfig(extra: Record<string, unknown> = {}): {
  cfg: Config;
  warnings: string[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-kit-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ ...BASE, ...extra }));
  const warnings: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown): true => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    return { cfg: loadConfig(file), warnings };
  } finally {
    process.stderr.write = write;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export { testConfig };
