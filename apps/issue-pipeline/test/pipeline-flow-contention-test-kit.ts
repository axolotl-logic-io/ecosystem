// Stage jobs contending for one issue (#133) in the full-flow world: each a
// built `job.mjs` started beside the test, so gates in the fake GitHub and
// barriers in fake pi can interleave them, and what GitHub and the origin
// keep of the issue's coordination and work.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import type { InvocationBinding } from "../src/coordination-records.ts";
import type { JobLine } from "../src/job/role-end.ts";
import { endsWithTest, killGroup } from "./bounded-test-kit.ts";
import type { OwnershipRecord } from "./fake-ownership.ts";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { ISSUE } from "./pipeline-flow-test-kit.ts";

const COORDINATION = "<!-- agent-pipeline:coordination\n";
const OWNER: string = new URL("./fake-ownership-owner.ts", import.meta.url)
  .pathname;
const ISSUE_SCOPE = JSON.stringify([
  "o/r",
  "integration",
  "issue",
  ISSUE,
  `agent/issue-${ISSUE}`,
]);

// Starts the caller's `stage` job for the issue on `lane`; resolves to its
// exit code, its line (null when it printed none) and its stderr.
function startStage(
  flow: Flow,
  stage: string,
  lane: string,
): Promise<{ code: number | null; line: JobLine | null; stderr: string }> {
  const args = [
    path.join(flow.root, "job.mjs"),
    "--config",
    flow.config,
    "--issue",
    String(ISSUE),
    "--branch",
    `agent/issue-${ISSUE}`,
    "--stage",
    stage,
    "--lane",
    lane,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: flow.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    endsWithTest(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        killGroup(child.pid);
      }
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      let line: JobLine | null = null;
      if (out.trim() !== "") {
        line = JSON.parse(out);
      }
      resolve({ code, line, stderr });
    });
  });
}

// The issue's execution records, in order, as the world keeps them.
function executionRecords(flow: Flow): OwnershipRecord[] {
  return readWorld(flow.ghDir)
    .comments.filter(({ body }) => body.startsWith(COORDINATION))
    .map(
      ({ id, body }): OwnershipRecord => ({
        id,
        ...JSON.parse(body.split("\n")[1] ?? ""),
      }),
    )
    .filter(({ scope }) => scope === ISSUE_SCOPE);
}

// Runs fake-ownership-owner.ts's `mode` for issue `issue`'s worktree on
// its legacy branch, as an ops request's owner does; returns its stdout.
function ownerScript(
  flow: Flow,
  mode: "owner" | "release",
  {
    issue = ISSUE,
    ...extra
  }: { issue?: number; lane?: string; execution?: object },
): string {
  const frame = {
    config: flow.config,
    number: issue,
    lane: "L",
    checkout: {
      issue,
      dir: path.join(flow.root, "work", "o__r", `issue-${issue}`),
      branch: `agent/issue-${issue}`,
    },
    ...extra,
  };
  const r = spawnSync(process.execPath, [OWNER, mode], {
    input: JSON.stringify(frame),
    encoding: "utf8",
    env: Object.fromEntries([
      ...Object.entries(flow.env),
      ["FAKE_OWNERSHIP_QUIET", "1"],
    ]),
  });
  if (r.status !== 0) {
    throw new Error(`${mode} #${issue} failed: ${r.stderr}`);
  }
  return r.stdout;
}

// Releases the issue's current owner, the request of `lane`'s latest
// invocation, as an operator's reconciliation would, through the real
// transport; returns its instance.
function releaseOwner(flow: Flow, lane: string): string {
  const owner = executionRecords(flow).findLast(
    (row): row is Extract<OwnershipRecord, { kind: "request" }> =>
      row.kind === "request" && row.identity.lane === lane,
  );
  if (owner === undefined) {
    throw new Error(`no invocation on lane ${lane} requested the issue`);
  }
  ownerScript(flow, "release", { execution: owner.identity });
  return owner.identity.instance;
}

// Acquires and confirms the issue for a new invocation on `lane`, as a job
// elsewhere would, through the real transport; returns its binding.
function acquireFor(flow: Flow, lane: string): InvocationBinding {
  return JSON.parse(ownerScript(flow, "owner", { lane }));
}

export {
  acquireFor,
  executionRecords,
  ISSUE_SCOPE,
  ownerScript,
  releaseOwner,
  startStage,
};
