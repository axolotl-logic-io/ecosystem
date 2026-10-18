// @ts-check
// Private, exact-argv script. Unlisted reads and writes fail; there is no
// system gh, keyring, network or provider fallback.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const COMMAND_TIMEOUT_MS = 20_000;
const UNEXPECTED_CALL = 91;
const STEP = z.object({
  args: z.array(z.string()),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  code: z.number().int().default(0),
  updates: z.array(z.tuple([z.string(), z.string()])).default([]),
});
const SCRIPT = z.object({
  origin: z.string(),
  steps: z.array(STEP),
});
const { HOME: home } = process.env;
if (home === undefined) {
  throw new Error("fake gh needs its isolated home");
}
const file = path.join(home, "gh-script.json");
const script = SCRIPT.parse(JSON.parse(fs.readFileSync(file, "utf8")));
const args = process.argv.slice(2);
fs.appendFileSync(
  path.join(home, "gh-calls.jsonl"),
  `${JSON.stringify(args)}\n`,
);
const [step] = script.steps;
if (step === undefined || JSON.stringify(step.args) !== JSON.stringify(args)) {
  process.stderr.write(`unexpected gh call: ${JSON.stringify(args)}\n`);
  process.exit(UNEXPECTED_CALL);
}
if (!script.origin.startsWith(`${home}${path.sep}`)) {
  throw new Error("fake gh refuses an origin outside its home");
}
if (step.code === 0) {
  for (const [ref, sha] of step.updates) {
    execFileSync("git", ["-C", script.origin, "update-ref", ref, sha], {
      timeout: COMMAND_TIMEOUT_MS,
    });
  }
}
script.steps.shift();
fs.writeFileSync(file, JSON.stringify(script));
process.stdout.write(step.stdout);
process.stderr.write(step.stderr);
process.exit(step.code);
