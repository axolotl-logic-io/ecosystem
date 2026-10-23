#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { check } from "../src/safe-refactor/check.ts";
import { engineOf } from "../src/safe-refactor/engine.ts";
import { projectOf, readText } from "../src/safe-refactor/project.ts";
import {
  ASSIGNMENT,
  messageOf,
  OPERATION,
} from "../src/safe-refactor/protocol.ts";
import { exactSource, runTask } from "../src/safe-refactor/task.ts";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      request: { type: "string" },
      artifacts: { type: "string" },
      operation: { type: "string" },
    },
  });
  const [command] = positionals;
  if (values.request === undefined || positionals.length !== 1) {
    throw new Error(
      "usage: safe-refactor check|run|operation --request FILE [--artifacts DIRECTORY] [--operation FILE]",
    );
  }
  const assignment = ASSIGNMENT.parse(JSON.parse(readText(values.request)));
  if (command === "check") {
    const project = projectOf(assignment);
    try {
      const evidence = check(project, assignment);
      console.log(JSON.stringify(evidence));
      if (evidence.checks.some((entry) => entry.verdict !== "passed")) {
        process.exitCode = 1;
      }
    } finally {
      project.dispose();
    }
    return;
  }
  if (values.artifacts === undefined || !path.isAbsolute(values.artifacts)) {
    throw new Error("an absolute external artifacts directory is required");
  }
  if (command === "run") {
    const result = await runTask(
      assignment,
      values.artifacts,
      path.join(import.meta.dirname, "safe-refactor-tool.mjs"),
    );
    console.log(JSON.stringify(result));
    if (result.outcome !== "reported") {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "operation" && values.operation !== undefined) {
    if (!fs.statSync(values.artifacts).isDirectory()) {
      throw new Error("artifacts directory is unavailable");
    }
    const operation = OPERATION.parse(JSON.parse(readText(values.operation)));
    if (
      operation.operation !== "inspect" &&
      operation.operation !== "check" &&
      operation.operation !== "read"
    ) {
      await exactSource(assignment);
    }
    const engine = engineOf(assignment, values.artifacts);
    try {
      console.log(JSON.stringify(engine.execute(operation)));
    } finally {
      engine.dispose();
    }
    return;
  }
  throw new Error("unknown command or missing operation file");
}

try {
  await main();
} catch (error: unknown) {
  console.error(messageOf(error));
  process.exitCode = 1;
}
