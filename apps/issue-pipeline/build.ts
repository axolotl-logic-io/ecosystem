// Builds the installed pipeline from src/ with esbuild:
//
//   node build.ts [outdir]   (outdir defaults to dist/ in this folder)
//
// writes <outdir>/workflow.js, <outdir>/ops.mjs, <outdir>/job.mjs and
// <outdir>/structured-output.mjs, the files the install copies. It prints nothing on success; on failure it prints esbuild's error to
// stderr and exits non-zero.
//
// The workflow is the body of an async function that pi-subagents runs with
// `args` and its tools in scope. Its helpers (src/workflow/) are bundled into
// an IIFE that defines `workflowModules`, placed ahead of the body; the body
// itself is transformed alone, never bundled: it keeps its top-level `await`
// and its globals and gains no imports. The build adds the body's `return`,
// since Biome, which lints the source, can't parse a top-level one.
// The ops CLI's entry, src/ops.ts, is bundled with the strict-TS modules it
// imports for Node into one ES module, ops.mjs, that keeps its `#!` line. The
// stage job's entry, src/job.ts, and its pi extension,
// src/job/structured-output.ts, are bundled the same way, into job.mjs and
// structured-output.mjs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Loader } from "esbuild";
import { build, transform } from "esbuild";

const SOURCE_DIR = path.join(import.meta.dirname, "src");
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, "dist");
const WORKFLOW_SOURCE = path.join(SOURCE_DIR, "workflow.js");
const WORKFLOW_HELPERS_SOURCE = path.join(SOURCE_DIR, "workflow", "index.ts");
// The variable the helpers' bundle defines, which the body reads them from.
const WORKFLOW_HELPERS_GLOBAL = "workflowModules";
// What the body returns: the body keeps its sweep's driver in `sweep`, and
// the wrapper ends it with this, so the run resolves to the sweep's summary.
const WORKFLOW_RESULT = "sweep.summary()";
const OPS_SOURCE = path.join(SOURCE_DIR, "ops.ts");
const WORKFLOW_OUTPUT = "workflow.js";
const OPS_OUTPUT = "ops.mjs";
// The Node ES modules built from one entry each: the ops CLI, the stage job,
// the job's pi extension, the orchestrator and the reports.
const NODE_MODULES: ReadonlyMap<string, string> = new Map([
  [OPS_SOURCE, OPS_OUTPUT],
  [path.join(SOURCE_DIR, "job.ts"), "job.mjs"],
  [path.join(SOURCE_DIR, "orchestrate.ts"), "orchestrate.mjs"],
  [path.join(SOURCE_DIR, "report.ts"), "report.mjs"],
  [
    path.join(SOURCE_DIR, "job", "structured-output.ts"),
    "structured-output.mjs",
  ],
]);

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
// globals, and the wrapper's first line and closing brace are cut from the
// output. The wrapper adds the body's `return`, which stays as its last
// statement: the source has none, since Biome can't parse a top-level one.
const WRAPPER_START = "async function issue_pipeline_workflow_body() {\n";
const WRAPPER_RETURN = `return ${WORKFLOW_RESULT};\n`;
const WRAPPER_END = "}\n";

function unwrap(code: string): string {
  if (!(code.startsWith(WRAPPER_START) && code.endsWith(WRAPPER_END))) {
    throw new Error("build: esbuild changed the workflow's wrapper function");
  }
  return code.slice(WRAPPER_START.length, code.length - WRAPPER_END.length);
}

// The helpers as one IIFE script: `var workflowModules = (() => {…})();`.
async function bundleWorkflowHelpers(): Promise<string> {
  const { outputFiles } = await build({
    bundle: true,
    charset: "utf8",
    entryPoints: [WORKFLOW_HELPERS_SOURCE],
    format: "iife",
    globalName: WORKFLOW_HELPERS_GLOBAL,
    logLevel: "silent",
    platform: "neutral",
    target: "esnext",
    // Not tsconfig.json: its `strict` would make esbuild open the bundle with
    // "use strict", which, ahead of the body, would make the whole sweep strict.
    tsconfigRaw: {},
    write: false,
  });
  const [bundle] = outputFiles;
  if (bundle === undefined) {
    throw new Error("build: esbuild wrote no bundle of the workflow's helpers");
  }
  return bundle.text;
}

async function buildWorkflow(outDir: string): Promise<void> {
  const helpers = await bundleWorkflowHelpers();
  const source = await readFile(WORKFLOW_SOURCE, "utf8");
  const result = await transform(
    `${WRAPPER_START}${source}\n${WRAPPER_RETURN}${WRAPPER_END}`,
    {
      charset: "utf8",
      loader: loaderFor(WORKFLOW_SOURCE),
      logLevel: "silent",
      sourcefile: WORKFLOW_SOURCE,
      target: "esnext",
    },
  );
  await writeFile(
    path.join(outDir, WORKFLOW_OUTPUT),
    `${helpers}${unwrap(result.code)}`,
  );
}

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
    await Promise.all([buildWorkflow(outDir), ...modules]);
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}

await main();
