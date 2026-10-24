// @ts-check
// A successor takes the issue between the job's claim and its first session
// (#168): run by fake-job-authority.mjs's ops wrapper after a claim whose
// scripted reply says `successor`, it releases the job's ownership, as an
// operator's reconciliation would, and acquires for a new invocation on
// another lane, all through the real coordination transport against the
// private fake GitHub. It reads the claim's ops request on stdin.
import fs from "node:fs";

const src = new URL("../../src/", import.meta.url).pathname;
const { loadConfig, withCheckout } = await import(`${src}config.ts`);
const { executionBinding, issueExecution, withExecution } = await import(
  `${src}execution.ts`
);

const request = JSON.parse(fs.readFileSync(0, "utf8"));
const cfg = withCheckout(loadConfig(request.config), request.checkout);
const owner = withExecution(cfg, request.execution);
issueExecution(owner, request.number).release();
const successor = withExecution(
  cfg,
  executionBinding(cfg, request.number, "successor"),
);
const guard = issueExecution(successor, request.number);
guard.request();
if (!guard.acquire()) {
  throw new Error("the successor didn't acquire");
}
