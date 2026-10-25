import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { ASSIGNMENT } from "../../src/safe-refactor/protocol.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import { git } from "../job/git-review-test-kit.ts";

const CLI = fileURLToPath(
  new URL("../../scripts/safe-refactor.ts", import.meta.url),
);
const BIOME = fileURLToPath(
  new URL("../../../../node_modules/@biomejs/biome/bin/biome", import.meta.url),
);
const TIMEOUT_MS = 60_000;
const TYPESCRIPT =
  "export function total(amount: number): number {\n  const adjustment = 2;\n  return amount > 0 ? amount * adjustment : amount + adjustment;\n}\n";
const JAVASCRIPT =
  "/** @param {number} amount @returns {number} */\nexport function total(amount) {\n  const adjustment = 2;\n  return amount > 0 ? amount * adjustment : amount + adjustment;\n}\n";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type AssignmentInput = z.input<typeof ASSIGNMENT>;

// A refactor fixture: its folder, the repo and artifacts folders in it, the
// source file's name and text, and the request file with its assignment.
interface Fixture {
  directory: string;
  root: string;
  artifacts: string;
  file: string;
  source: string;
  request: string;
  // as the request file holds it, before the CLI parses it
  assignment: AssignmentInput;
}

function fixture(extension: "ts" | "js" = "ts"): Fixture {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(isolatedRoot, "refactor-")),
  );
  const root = path.join(directory, "repo");
  const artifacts = path.join(directory, "artifacts");
  fs.mkdirSync(root);
  fs.mkdirSync(artifacts);
  const file = `source.${extension}`;
  let source = TYPESCRIPT;
  if (extension === "js") {
    source = JAVASCRIPT;
  }
  fs.writeFileSync(path.join(root, file), source);
  fs.writeFileSync(
    path.join(root, "GLOSSARY.md"),
    "# Domain\n\nAmount is a subtotal before adjustment.\n",
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
      },
      include: [file],
    }),
  );
  fs.writeFileSync(
    path.join(root, "biome.jsonc"),
    JSON.stringify({
      root: true,
      formatter: { enabled: false },
      assist: { enabled: false },
      linter: { rules: { recommended: false } },
    }),
  );
  fs.writeFileSync(
    path.join(root, "metrics.jsonc"),
    JSON.stringify({
      extends: ["./biome.jsonc"],
      linter: {
        rules: {
          style: {
            noExcessiveLinesPerFile: {
              level: "error",
              options: { maxLines: 3, skipBlankLines: false },
            },
          },
          complexity: {
            noExcessiveLinesPerFunction: {
              level: "error",
              options: { maxLines: 2, skipBlankLines: false, skipIifes: false },
            },
            noExcessiveCognitiveComplexity: {
              level: "error",
              options: { maxAllowedComplexity: 1 },
            },
          },
        },
      },
    }),
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  const assignment: AssignmentInput = {
    root,
    revision: git(root, ["rev-parse", "HEAD"]).trim(),
    policy: hash(fs.readFileSync(path.join(root, "metrics.jsonc"), "utf8")),
    behavior: "js-values-effects-v1",
    requirements:
      "Preserve results and public names. Improve domain names and expose the adjustment calculation without metric dodges.",
    prompt: "Refactor the assigned source and explain any deferred metrics.",
    project: "tsconfig.json",
    files: [file],
    biome: BIOME,
    profile: "metrics.jsonc",
    model: "openai/gpt-6.1-sol",
    runtime: {},
  };
  const request = path.join(directory, "request.json");
  fs.writeFileSync(request, JSON.stringify(assignment));
  return { directory, root, artifacts, file, source, request, assignment };
}

function call(
  project: ReturnType<typeof fixture>,
  operation: unknown,
): SpawnSyncReturns<string> {
  const file = path.join(project.directory, "operation.json");
  fs.writeFileSync(file, JSON.stringify(operation));
  return spawnSync(
    process.execPath,
    [
      CLI,
      "operation",
      "--request",
      project.request,
      "--artifacts",
      project.artifacts,
      "--operation",
      file,
    ],
    { encoding: "utf8", timeout: TIMEOUT_MS },
  );
}

function rename(project: ReturnType<typeof fixture>): {
  operation: string;
  target: { file: string; symbol: string };
  source: string;
  name: string;
  rationale: string;
} {
  return {
    operation: "rename-symbol",
    target: { file: project.file, symbol: "total.amount" },
    source: hash(
      fs.readFileSync(path.join(project.root, project.file), "utf8"),
    ),
    name: "subtotal",
    rationale: "Name the subtotal before its domain adjustment.",
  };
}

function behavior(project: ReturnType<typeof fixture>): string {
  const script = `import { total } from ${JSON.stringify(new URL(`file://${path.join(project.root, project.file)}`).href)}; console.log(JSON.stringify([-10, -1, 0, 1, 2, 100].map(total)));`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: TIMEOUT_MS },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

function commitFixture(project: ReturnType<typeof fixture>): void {
  git(project.root, ["add", "."]);
  git(project.root, ["commit", "-qm", "changed fixture"]);
  project.assignment.revision = git(project.root, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(project.request, JSON.stringify(project.assignment));
}

export {
  BIOME,
  behavior,
  CLI,
  call,
  commitFixture,
  fixture,
  hash,
  rename,
  TIMEOUT_MS,
};
