// Only scripted ops pushes are intercepted. Every successful mutation still
// uses real receive-pack against this world's private bare origin.

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const STEP = z.object({
  args: z.array(z.string()),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  code: z.number().optional(),
  interrupt: z.boolean().optional(),
  updates: z.array(z.tuple([z.string(), z.string()])).optional(),
  skipMutation: z.boolean().optional(),
});
const SCRIPT = z.object({ origin: z.string(), steps: z.array(STEP) });
const {
  HOME: home = "",
  ISSUE_PIPELINE_OPS: ops,
  TEST_REAL_GIT: real = "",
}: NodeJS.ProcessEnv = process.env;
const args = process.argv.slice(2);
const scriptFile = path.join(home, "gh-script.json");
function delegate(command: string[]): SpawnSyncReturns<NonSharedBuffer> {
  return spawnSync(real, command, { stdio: "inherit", timeout: 20_000 });
}
if (ops !== "1" || !args.includes("push") || !fs.existsSync(scriptFile)) {
  process.exit(delegate(args).status ?? 1);
}
const script = SCRIPT.parse(JSON.parse(fs.readFileSync(scriptFile, "utf8")));
const [step]: z.infer<typeof STEP>[] = script.steps;
fs.appendFileSync(
  path.join(home, "gh-calls.jsonl"),
  `${JSON.stringify(["git", ...args])}\n`,
);
if (step === undefined || JSON.stringify(step.args) !== JSON.stringify(args)) {
  throw new Error(`unexpected git mutation: ${JSON.stringify(args)}`);
}
if (!script.origin.startsWith(`${home}${path.sep}`)) {
  throw new Error("scripted git requires a private origin");
}
script.steps.shift();
fs.writeFileSync(scriptFile, JSON.stringify(script));
let code = 0;
if (step.skipMutation !== true) {
  code = delegate(args).status ?? 1;
}
for (const [ref, sha] of step.updates ?? []) {
  const updated = delegate(["-C", script.origin, "update-ref", ref, sha]);
  if (updated.status !== 0) {
    throw new Error("fixture update failed");
  }
}
if (step.interrupt === true) {
  process.kill(process.ppid, "SIGKILL");
  process.exit(0);
}
process.stdout.write(step.stdout ?? "");
process.stderr.write(step.stderr ?? "");
process.exit(step.code ?? code);
