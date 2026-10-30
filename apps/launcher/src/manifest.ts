// Installed registrations are explicit, relocatable paths, never task-name conventions.
import fs from "node:fs";
import path from "node:path";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { untrustedFile } from "@ecosystem/task-runtime/trusted-file";
import { z } from "zod";

const TASK = /^[a-z][a-z0-9-]*$/u;
const MANIFEST = z.strictObject({
  version: z.literal(1),
  tasks: z.array(
    z.strictObject({
      id: z.string().regex(TASK),
      executable: z.string().min(1),
    }),
  ),
});

// Validates the entire manifest and all programs before identity checks or discovery.
function readManifest(file: string): ReadonlyMap<string, string> {
  if (untrustedFile(file) !== null) {
    throw new OpsError(
      "task manifest must be an operator-owned regular file writable only by its owner",
    );
  }
  const manifest = MANIFEST.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const programs = new Map<string, string>();
  for (const { id, executable } of manifest.tasks) {
    if (programs.has(id)) {
      throw new OpsError(`duplicate task registration: ${id}`);
    }
    const program = path.resolve(path.dirname(file), executable);
    if (untrustedFile(program) !== null) {
      throw new OpsError(`task ${id} has no installed task app at ${program}`);
    }
    programs.set(id, program);
  }
  return programs;
}

export { readManifest };
