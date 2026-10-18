// @ts-check
// A loaded pipeline config for tests of the modules that take one, written to
// a temporary file, with the warnings loadConfig printed while loading it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../src/config.ts";

const BASE = {
  repo: "example/repo",
  account: "pipeline-bot",
  allowedUsers: ["owner"],
  commands: { test: "true" },
};

/**
 * @param {Record<string, unknown>} [extra] keys over the base config
 * @returns {{ cfg: import("../src/config.ts").Config, warnings: string[] }}
 */
function testConfig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-kit-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ ...BASE, ...extra }));
  /** @type {string[]} */
  const warnings = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
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
