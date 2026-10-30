// Bundles the distribution in programs.ts and its compiler/Python assets.
// Usage: node build.ts [outdir] (defaults to this folder's dist/).

import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { ASSETS, PROGRAMS, TASKS } from "./programs.ts";

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
      PROGRAMS.map(({ source, file }) =>
        buildNodeModule(
          path.resolve(import.meta.dirname, source),
          path.join(outDir, file),
        ),
      ),
    );
    await writeFile(
      path.join(outDir, "tasks.json"),
      `${JSON.stringify({ version: 1, tasks: TASKS.map((id) => ({ id, executable: `${id}.mjs` })) }, null, 2)}\n`,
    );
    await Promise.all(
      ASSETS.map(async ({ source, file }): Promise<void> => {
        const target = path.join(outDir, file);
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(import.meta.dirname, source), target);
      }),
    );
  } catch (error: unknown) {
    console.error(messageOf(error));
    process.exitCode = 1;
  }
}

await main();
