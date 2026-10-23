// Builds the installed pipeline from src/ and scripts/ with esbuild:
//
//   node build.ts [outdir]   (outdir defaults to dist/ in this folder)
//
// writes the executables the install copies, each bundled from one strict-TS
// entry with the modules it imports for Node into one ES module that keeps
// its `#!` line: the ops CLI <outdir>/ops.mjs (src/ops.ts) and the shell
// supervisor it runs each command through (<outdir>/shell-supervisor.mjs),
// the stage job <outdir>/job.mjs (src/job.ts) and its pi extensions
// <outdir>/structured-output.mjs, <outdir>/pipeline-commit.mjs and
// <outdir>/git-review.mjs, the
// orchestrator <outdir>/orchestrate.mjs, the reports <outdir>/report.mjs
// and the caller's job launcher <outdir>/caller-jobs.mjs
// (scripts/caller-jobs.ts).
// It prints nothing on success; on failure it prints esbuild's error to
// stderr and exits non-zero.

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const BACKEND_PACKAGE = path.dirname(
  fileURLToPath(import.meta.resolve("typescript/package.json")),
);
const BACKEND_DIRECTORY = `vendor/node_modules/typescript-${ts.version}`;
const BACKEND_IMPORT = `./${BACKEND_DIRECTORY}/lib/typescript.js`;

const SOURCE_DIR = path.join(import.meta.dirname, "src");
const SCRIPTS_DIR = path.join(import.meta.dirname, "scripts");
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, "dist");
// The Node ES modules built from one entry each: the ops CLI and its shell
// supervisor, the stage job, the job's pi extensions, the orchestrator, the
// reports and the caller's job launcher.
const NODE_MODULES: ReadonlyMap<string, string> = new Map([
  [path.join(SCRIPTS_DIR, "safe-refactor.ts"), "safe-refactor.mjs"],
  [path.join(SOURCE_DIR, "safe-refactor", "tool.ts"), "safe-refactor-tool.mjs"],
  [path.join(SOURCE_DIR, "job", "git-review.ts"), "git-review.mjs"],
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
  [path.join(SCRIPTS_DIR, "caller-jobs.ts"), "caller-jobs.mjs"],
]);

async function buildNodeModule(source: string, outfile: string): Promise<void> {
  await build({
    bundle: true,
    // Keep the compiler with its real CommonJS file and declaration assets.
    // Resolve the external alias relative to the relocatable distribution.
    absWorkingDir: path.dirname(outfile),
    alias: { typescript: BACKEND_IMPORT },
    external: [BACKEND_IMPORT],
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
    await cp(BACKEND_PACKAGE, path.join(outDir, BACKEND_DIRECTORY), {
      recursive: true,
    });
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
