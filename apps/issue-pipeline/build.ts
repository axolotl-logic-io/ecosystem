// Builds the installed pipeline from src/ with esbuild:
//
//   node build.ts [outdir]   (outdir defaults to dist/ in this folder)
//
// writes <outdir>/workflow.js and <outdir>/ops.mjs, the two files the install
// copies. It prints nothing on success; on failure it prints esbuild's error to
// stderr and exits non-zero.
//
// The workflow is the body of an async function that pi-subagents runs with
// `args` and its tools in scope, so it is transformed alone, never bundled: it
// keeps its top-level `await` and `return`, its globals and gains no imports.
// The ops CLI is bundled for Node into one ES module that keeps its `#!` line.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Loader } from "esbuild";
import { build, transform } from "esbuild";

const SOURCE_DIR = path.join(import.meta.dirname, "src");
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, "dist");
const WORKFLOW_SOURCE = path.join(SOURCE_DIR, "workflow.js");
const OPS_SOURCE = path.join(SOURCE_DIR, "ops.mjs");
const WORKFLOW_OUTPUT = "workflow.js";
const OPS_OUTPUT = "ops.mjs";

// esbuild's loader for each source extension the pipeline uses.
const LOADERS: ReadonlyMap<string, Loader> = new Map<string, Loader>([
  [".js", "js"],
  [".mjs", "js"],
  [".ts", "ts"],
  [".mts", "ts"],
]);

function loaderFor(file: string): Loader {
  const loader = LOADERS.get(path.extname(file));
  if (loader === undefined) {
    throw new Error(`build: no loader for ${file}`);
  }
  return loader;
}

// esbuild reads top-level `await` as a sign of an ES module, where a top-level
// `return` is an error (evanw/esbuild#1814). So the body is transformed inside
// this wrapper, which takes no parameters so that `args` and the tools stay
// globals, and the wrapper's first and last lines are cut from the output.
const WRAPPER_START = "async function issue_pipeline_workflow_body() {\n";
const WRAPPER_END = "}\n";

function unwrap(code: string): string {
  if (!(code.startsWith(WRAPPER_START) && code.endsWith(WRAPPER_END))) {
    throw new Error("build: esbuild changed the workflow's wrapper function");
  }
  return code.slice(WRAPPER_START.length, code.length - WRAPPER_END.length);
}

async function buildWorkflow(outDir: string): Promise<void> {
  const source = await readFile(WORKFLOW_SOURCE, "utf8");
  const result = await transform(`${WRAPPER_START}${source}\n${WRAPPER_END}`, {
    charset: "utf8",
    loader: loaderFor(WORKFLOW_SOURCE),
    logLevel: "silent",
    sourcefile: WORKFLOW_SOURCE,
    target: "esnext",
  });
  await writeFile(path.join(outDir, WORKFLOW_OUTPUT), unwrap(result.code));
}

async function buildOps(outDir: string): Promise<void> {
  await build({
    bundle: true,
    charset: "utf8",
    entryPoints: [OPS_SOURCE],
    format: "esm",
    logLevel: "silent",
    outfile: path.join(outDir, OPS_OUTPUT),
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
    await Promise.all([buildWorkflow(outDir), buildOps(outDir)]);
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}

await main();
