// Observes the real built ops in an isolated full-flow root. A marker can
// interrupt the finish op before it runs, after the role saved security and
// the completion.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Flow } from "./pipeline-flow-test-kit.ts";

const REQUEST = /BEGIN_OPS_REQUEST\s*(?<json>[\s\S]*?)\s*END_OPS_REQUEST/u;
const RUN_MS = 60_000;

async function runFlowOps(root: string): Promise<void> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  const { json = "{}" } = REQUEST.exec(input)?.groups ?? {};
  const request = JSON.parse(json);
  let output: string;
  const marker = path.join(root, "interrupt-finish");
  if (request.op === "finish" && fs.existsSync(marker)) {
    output = JSON.stringify({ ok: false, error: "read ECONNRESET" });
  } else {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "real-ops.mjs")],
      {
        input,
        env: process.env,
        encoding: "utf8",
        timeout: RUN_MS,
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `real ops exited ${result.status} (signal ${result.signal}, error ${result.error?.message ?? "none"}): ${result.stderr}`,
      );
    }
    output = result.stdout;
  }
  fs.appendFileSync(
    path.join(root, "ops-trace.jsonl"),
    `${JSON.stringify({ request, reply: JSON.parse(output) })}\n`,
  );
  process.stdout.write(output);
}

function observeOps(flow: Flow): void {
  const original = path.join(flow.root, "ops.mjs");
  fs.renameSync(original, path.join(flow.root, "real-ops.mjs"));
  const kit = new URL(import.meta.url).pathname;
  fs.writeFileSync(
    original,
    `import { runFlowOps } from ${JSON.stringify(kit)};\nawait runFlowOps(${JSON.stringify(flow.root)});\n`,
  );
}

function opsTrace(
  flow: Flow,
): { request: { op: string }; reply: Record<string, unknown> }[] {
  return fs
    .readFileSync(path.join(flow.root, "ops-trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

export { observeOps, opsTrace, runFlowOps };
