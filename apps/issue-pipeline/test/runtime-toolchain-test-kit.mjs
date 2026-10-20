// @ts-check
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { privateRuntime } from "./runtime-policy-test-kit.mjs";

const LOCATIONS = [
  "MISE_DATA_DIR",
  "MISE_STATE_DIR",
  "MISE_CACHE_DIR",
  "MISE_CONFIG_DIR",
  "MISE_GLOBAL_CONFIG_FILE",
];

/** @param {boolean} shims */
function toolchainRuntime(shims) {
  const kit = privateRuntime();
  const bin = path.join(kit.root, "bin");
  const operatorHome = path.join(kit.root, "operator");
  const personal = path.join(operatorHome, ".pi", "agent");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(
    path.join(personal, "auth.json"),
    '{"personal":"synthetic-personal-auth"}',
  );
  fs.writeFileSync(
    path.join(personal, "settings.json"),
    '{"packages":["personal-package"],"compaction":{"enabled":false}}',
  );
  const toolchain = Object.fromEntries([
    ["PATH", bin],
    ...LOCATIONS.map((name) => [name, path.join(operatorHome, name)]),
  ]);
  installTools(bin, operatorHome, shims);
  const report = path.join(kit.root, "tool-report.jsonl");
  const operatorEnv = {
    ...kit.env,
    ...toolchain,
    ...Object.fromEntries([["HOME", operatorHome]]),
  };
  /** @returns {unknown[]} */
  function reports() {
    return fs
      .readFileSync(report, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }
  /** @returns {import("node:child_process").SpawnSyncReturns<string>} */
  function comparison() {
    return spawnSync("pi", ["--version", "--offline"], {
      cwd: kit.root,
      env: {
        ...operatorEnv,
        ...Object.fromEntries([["FAKE_TOOLCHAIN_REPORT", report]]),
      },
      encoding: "utf8",
      timeout: 3000,
    });
  }
  Object.assign(
    kit.env,
    Object.fromEntries([["FAKE_TOOLCHAIN_REPORT", report]]),
  );
  return { ...kit, toolchain, operatorHome, comparison, reports };
}

/** @param {string} bin @param {string} operatorHome @param {boolean} shims @returns {void} */
function installTools(bin, operatorHome, shims) {
  // A deliberately HOME-relative fixture, not the host's mise installation.
  // The five locations represent install, trust/state, cache and configuration.
  let guard = "";
  if (shims) {
    guard = LOCATIONS.map(
      (name) =>
        `if [ "\${${name}:-$HOME/${name}}" != '${path.join(operatorHome, name)}' ]; then echo 'No version is set for shim: node' >&2; exit 127; fi`,
    ).join("\n");
  }
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh\n${guard}\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o700 },
  );
  for (const command of ["npm", "mise"]) {
    fs.writeFileSync(
      path.join(bin, command),
      `#!/bin/sh\n${guard}\nprintf '%s\\n' '${command}-fixture-1.0'\n`,
      { mode: 0o700 },
    );
  }
  const pi = path.join(bin, "pi");
  const fake = fs.readFileSync(pi, "utf8");
  fs.writeFileSync(
    pi,
    fake.replace(`#!${process.execPath}`, "#!/usr/bin/env node"),
  );
}

export { toolchainRuntime };
