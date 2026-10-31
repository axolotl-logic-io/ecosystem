// The launcher CLI as a subprocess: task programs come from the install root.
import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "../../src/cli.ts");
const NO_PROGRAM = /no installed task app/u;
const RETIRED_OPTION = /manifest/u;
const DEADLINE_MS = 30_000;

function sandbox(): {
  installRoot: string;
  launcher: (...args: string[]) => SpawnSyncReturns<string>;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-programs-"));
  const installRoot = path.join(root, "release");
  fs.mkdirSync(installRoot);
  const repository = path.join(root, "repo.json");
  fs.writeFileSync(repository, JSON.stringify({ repo: "acme/widgets" }));
  const buddy = path.join(root, "buddy.json");
  // The credential file never exists: checking reads no token.
  fs.writeFileSync(
    buddy,
    JSON.stringify({
      version: 2,
      name: "first",
      scope: { repositories: [repository] },
      tasks: ["verify", "fix"],
      account: {
        login: "first",
        credentials: { file: path.join(root, "absent"), variable: "TOKEN" },
      },
    }),
  );
  return {
    installRoot,
    launcher: (...args: string[]): SpawnSyncReturns<string> =>
      spawnSync(process.execPath, [CLI, "--config", buddy, ...args], {
        env: {
          ...process.env,
          ...Object.fromEntries([["ECOSYSTEM_INSTALL_ROOT", installRoot]]),
        },
        encoding: "utf8",
        timeout: DEADLINE_MS,
      }),
    cleanup: (): void => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("check resolves each task to its program in the install root", () => {
  const box = sandbox();
  try {
    for (const task of ["verify", "fix"]) {
      fs.writeFileSync(path.join(box.installRoot, `${task}.mjs`), "");
    }
    const checked = box.launcher("--check");
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout).apps, {
      verify: path.join(box.installRoot, "verify.mjs"),
      fix: path.join(box.installRoot, "fix.mjs"),
    });
    fs.unlinkSync(path.join(box.installRoot, "fix.mjs"));
    const missing = box.launcher("--check");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, NO_PROGRAM);
  } finally {
    box.cleanup();
  }
});

test("the retired manifest option is refused", () => {
  const box = sandbox();
  try {
    const refused = box.launcher(
      "--manifest",
      path.join(box.installRoot, "tasks.json"),
      "--check",
    );
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, RETIRED_OPTION);
  } finally {
    box.cleanup();
  }
});
