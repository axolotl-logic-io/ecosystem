// A successor takes the issue between the job's claim and its first session
// (#168): run by fake-job-authority.ts's ops wrapper after a claim whose
// scripted reply says `successor`, it releases the job's ownership, as an
// operator's reconciliation would, and acquires for a new invocation on
// another lane, all through the real coordination transport against the
// private fake GitHub. It reads the claim's ops request on stdin. When the
// claim's reply says `successor: "with-work"`, the job's checkout then also
// holds a local commit and an uncommitted file, as a stale job's would.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const src: string = new URL("../../src/", import.meta.url).pathname;
const { loadConfig, withCheckout }: typeof import("../../src/config.ts") =
  await import(`${src}config.ts`);
const {
  executionBinding,
  issueExecution,
  withExecution,
}: typeof import("../../src/execution.ts") = await import(`${src}execution.ts`);

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
const replies = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(request.config), "replies.json"),
    "utf8",
  ),
);
function git(dir: string, ...args: string[]): void {
  const id = ["-c", "user.name=a", "-c", "user.email=a@b"];
  const config = [...id, "-c", "commit.gpgsign=false"];
  // The checkout's hooks let only the pipeline's own commits through.
  const env = {
    ...process.env,
    ...Object.fromEntries([["ISSUE_PIPELINE_COMMIT", "1"]]),
  };
  execFileSync("git", ["-C", dir, ...config, ...args], { env });
}
if (replies.claim?.successor === "with-work") {
  const { dir } = request.checkout;
  fs.writeFileSync(path.join(dir, "committed.txt"), "local commit\n");
  git(dir, "add", "committed.txt");
  git(dir, "commit", "-q", "-m", "stale local work");
  fs.writeFileSync(path.join(dir, "uncommitted.txt"), "local edit\n");
}
