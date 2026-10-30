import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { PROGRAMS } from "../programs.ts";

for (const { file } of PROGRAMS) {
  const result = spawnSync(
    process.execPath,
    ["--check", path.join(import.meta.dirname, "..", "dist", file)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exitCode = 1;
  }
}
