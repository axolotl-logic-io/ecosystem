import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readManifest } from "../../src/manifest.ts";

test("registrations resolve arbitrary executable names beside the manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-manifest-"));
  try {
    fs.writeFileSync(path.join(root, "worker.mjs"), "");
    const file = path.join(root, "tasks.json");
    const entry = { id: "verify", executable: "worker.mjs" };
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [entry] }));
    assert.equal(
      readManifest(file).get("verify"),
      path.join(root, "worker.mjs"),
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, tasks: [entry, entry] }),
    );
    assert.throws(() => readManifest(file));
    fs.writeFileSync(file, JSON.stringify({ version: 2, tasks: [entry] }));
    assert.throws(() => readManifest(file));
    fs.unlinkSync(path.join(root, "worker.mjs"));
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: [entry] }));
    assert.throws(() => readManifest(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
