// @ts-check
// Acquires or takes issue execution through the real coordination transport
// against the ops CLI tests' fake gh (fake-ownership.mjs). It reads the
// frame on stdin: the config, issue, lane and checkout.
//
//   owner      acquire for a new invocation on the frame's lane, and print
//              its binding
//   successor  release the frame's owner, as an operator's reconciliation
//              would, and acquire for a new invocation on lane `successor`
//   release    release the frame's owner, as a job does after a resolved run
import fs from "node:fs";
import process from "node:process";

const src = new URL("../src/", import.meta.url).pathname;
const { loadConfig, withCheckout } = await import(`${src}config.ts`);
const { executionBinding, issueExecution, withExecution } = await import(
  `${src}execution.ts`
);

const frame = JSON.parse(fs.readFileSync(0, "utf8"));
const cfg = withCheckout(loadConfig(frame.config), frame.checkout);

/** @param {string} lane @returns {any} */
function acquire(lane) {
  const binding = executionBinding(cfg, frame.number, lane);
  const guard = issueExecution(withExecution(cfg, binding), frame.number);
  guard.request();
  if (!guard.acquire()) {
    throw new Error(`lane ${lane} didn't acquire #${frame.number}`);
  }
  return binding;
}

const [, , mode] = process.argv;
if (mode === "successor" || mode === "release") {
  issueExecution(withExecution(cfg, frame.execution), frame.number).release();
}
if (mode === "successor") {
  acquire("successor");
} else if (mode === "owner") {
  process.stdout.write(JSON.stringify(acquire(frame.lane)));
}
