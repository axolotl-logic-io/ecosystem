// Bundles the distribution in programs.ts and its compiler/Python assets.
// Usage: node build.ts [outdir] (defaults to this folder's dist/).
// Retired delivery executables are removed from an existing output folder.

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { PROGRAMS, RETIRED_PROGRAMS } from "./programs.ts";

const BACKEND_PACKAGE = path.dirname(
  fileURLToPath(import.meta.resolve("typescript/package.json")),
);
const BACKEND_DIRECTORY = `vendor/node_modules/typescript-${ts.version}`;
const BACKEND_IMPORT = `./${BACKEND_DIRECTORY}/lib/typescript.js`;
// yaml's Node entry is CommonJS that requires node:process at load time,
// which an ES module bundle can't; its ES module build needs no Node API.
const YAML_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("yaml/package.json"))),
  "browser",
  "index.js",
);

const SOURCE_DIR = path.join(import.meta.dirname, "src");
// The hash-pinned poetry and pip-audit the standards upgrade installs in its
// sandbox, which the built entrypoint reads from beside itself.
const PYTHON_TOOLS = path.join(SOURCE_DIR, "standards", "python-tools.txt");
const DEFAULT_OUT_DIR = path.join(import.meta.dirname, "dist");

async function buildNodeModule(source: string, outfile: string): Promise<void> {
  await build({
    bundle: true,
    // Keep the compiler with its real CommonJS file and declaration assets.
    // Resolve the external alias relative to the relocatable distribution.
    absWorkingDir: path.dirname(outfile),
    alias: { typescript: BACKEND_IMPORT, yaml: YAML_MODULE },
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
    await Promise.all(
      RETIRED_PROGRAMS.map((file) =>
        rm(path.join(outDir, file), { force: true }),
      ),
    );
    await Promise.all(
      PROGRAMS.map(({ source, file }) =>
        buildNodeModule(
          path.join(import.meta.dirname, source),
          path.join(outDir, file),
        ),
      ),
    );
    await cp(PYTHON_TOOLS, path.join(outDir, "standards-python-tools.txt"));
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}

await main();
