// @ts-check
// Scripted model edits before the real pipeline_commit call.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** @param {{ files?: Record<string, string>, gitlinks?: Record<string, string> }} turn @returns {void} */
function writeTurnFiles(turn) {
  for (const [file, text] of Object.entries(turn.files ?? {})) {
    const where = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(where), { recursive: true });
    fs.writeFileSync(where, text);
  }
  for (const [file, oid] of Object.entries(turn.gitlinks ?? {})) {
    fs.mkdirSync(path.join("repo", file), { recursive: true });
    execFileSync(
      "git",
      [
        "-C",
        "repo",
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${oid},${file}`,
      ],
      { timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  }
}

export { writeTurnFiles };
