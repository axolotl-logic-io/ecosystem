// Builds the installed pipeline from src/ with esbuild:
//
//   node build.ts [outdir]   (outdir defaults to dist/ in this folder)
//
// writes the executables the install copies, each bundled from one strict-TS
// entry with the modules it imports for Node into one ES module that keeps
// its `#!` line: the ops CLI <outdir>/ops.mjs (src/ops.ts) and the shell
// supervisor it runs each command through (<outdir>/shell-supervisor.mjs),
// the stage job <outdir>/job.mjs (src/job.ts) and its pi extensions
// <outdir>/structured-output.mjs and <outdir>/pipeline-commit.mjs, the
// orchestrator <outdir>/orchestrate.mjs and the reports <outdir>/report.mjs.
// It prints nothing on success; on failure it prints esbuild's error to
// stderr and exits non-zero.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

const SOURCE_DIR = path.join(import.meta.dirname, "src");
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, "dist");
// The Node ES modules built from one entry each: the ops CLI and its shell
// supervisor, the stage job, the job's pi extensions, the orchestrator and
// the reports.
const NODE_MODULES: ReadonlyMap<string, string> = new Map([
  [path.join(SOURCE_DIR, "ops.ts"), "ops.mjs"],
  [path.join(SOURCE_DIR, "shell-supervisor.ts"), "shell-supervisor.mjs"],
  [path.join(SOURCE_DIR, "job.ts"), "job.mjs"],
  [path.join(SOURCE_DIR, "orchestrate.ts"), "orchestrate.mjs"],
  [path.join(SOURCE_DIR, "report.ts"), "report.mjs"],
  [
    path.join(SOURCE_DIR, "job", "structured-output.ts"),
    "structured-output.mjs",
  ],
  [
    path.join(SOURCE_DIR, "job", "pipeline-commit-tool.ts"),
    "pipeline-commit.mjs",
  ],
]);

async function buildNodeModule(source: string, outfile: string): Promise<void> {
  await build({
    bundle: true,
    charset: "utf8",
    entryPoints: [source],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node",
    target: "node24",
  });
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  const [, , outArg] = process.argv;
  const outDir = path.resolve(outArg ?? DEFAULT_OUT_DIR);
  try {
    await mkdir(outDir, { recursive: true });
    const modules = [...NODE_MODULES].map(([source, output]) =>
      buildNodeModule(source, path.join(outDir, output)),
    );
    await Promise.all(modules);
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}

await main();
