import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { engineOf } from "../../src/safe-refactor/engine.ts";
import { digest } from "../../src/safe-refactor/project.ts";
import {
  ASSIGNMENT,
  type Assignment,
} from "../../src/safe-refactor/protocol.ts";

const PIPELINE = path.resolve(import.meta.dirname, "../..");
const BIOME = path.resolve(
  PIPELINE,
  "../../node_modules/@biomejs/biome/bin/biome",
);
const TIMEOUT_MS = 60_000;
const COMMIT_HEX_LENGTH = 40;
const SOURCE =
  "export function total(amount: number): number {\n  return amount + 1;\n}\n";

interface RefactorFixture {
  directory: string;
  root: string;
  artifacts: string;
  assignment: Assignment;
  source: (file?: string) => string;
  operation: (
    operation: string,
    symbol: string,
    fields?: Record<string, unknown>,
    file?: string,
  ) => Record<string, unknown>;
  engine: () => ReturnType<typeof engineOf>;
  behavior: (inputs?: readonly unknown[]) => string;
  cli: (operation: unknown) => ReturnType<typeof spawnSync>;
  cleanup: () => void;
}

function fixture(
  sources: Record<string, string> = { "source.ts": SOURCE },
  settings: Record<string, unknown> = {},
  assigned = Object.keys(sources),
  checker: Record<string, unknown> = {},
): RefactorFixture {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "refactor-types-")),
  );
  const root = path.join(directory, "repo");
  const artifacts = path.join(directory, "artifacts");
  fs.mkdirSync(root);
  fs.mkdirSync(artifacts);
  for (const [file, text] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.writeFileSync(
    path.join(root, "GLOSSARY.md"),
    "# Counter\n\nAmount is the count before one increment.\n",
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        types: [],
        lib: ["ES2023"],
        noEmit: true,
        allowImportingTsExtensions: true,
        ...settings,
      },
      include: Object.keys(sources),
    }),
  );
  fs.writeFileSync(
    path.join(root, "biome.jsonc"),
    JSON.stringify({
      root: true,
      formatter: { indentStyle: "space", indentWidth: 2 },
      linter: { rules: { recommended: true } },
      ...checker,
    }),
  );
  const profile = JSON.stringify({
    extends: ["./biome.jsonc"],
    linter: {
      rules: {
        style: {
          noExcessiveLinesPerFile: {
            level: "error",
            options: { maxLines: 300, skipBlankLines: false },
          },
        },
        complexity: {
          noExcessiveLinesPerFunction: {
            level: "error",
            options: { maxLines: 50, skipBlankLines: false, skipIifes: false },
          },
          noExcessiveCognitiveComplexity: {
            level: "error",
            options: { maxAllowedComplexity: 15 },
          },
        },
      },
    },
  });
  fs.writeFileSync(path.join(root, "metrics.jsonc"), profile);
  const assignment = ASSIGNMENT.parse({
    root,
    revision: "a".repeat(COMMIT_HEX_LENGTH),
    policy: digest(profile),
    behavior: "js-values-effects-v1",
    requirements:
      "Preserve counter values and effects while clarifying its types.",
    prompt: "Use type-only operations and preserve all checks.",
    project: "tsconfig.json",
    files: assigned,
    biome: BIOME,
    profile: "metrics.jsonc",
    model: "openai/gpt-6.1-sol",
    runtime: {},
  });
  // Match the real caller's clean, formatted baseline rather than relying
  // on a permissive fake checker or a disabled formatter.
  const format = spawnSync(
    process.execPath,
    [BIOME, "format", "--write", "."],
    { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS },
  );
  if (format.status !== 0) {
    throw new Error(
      `fixture formatting failed: ${format.stdout}\n${format.stderr}`,
    );
  }
  assignment.policy = digest(
    fs.readFileSync(path.join(root, "metrics.jsonc"), "utf8"),
  );
  function source(file = "source.ts"): string {
    return fs.readFileSync(path.join(root, file), "utf8");
  }
  function operation(
    name: string,
    symbol: string,
    fields: Record<string, unknown> = {},
    file = "source.ts",
  ): Record<string, unknown> {
    return {
      operation: name,
      target: { file, symbol },
      source: digest(source(file)),
      rationale: "Clarify the counter's type without changing JavaScript.",
      ...fields,
    };
  }
  return {
    directory,
    root,
    artifacts,
    assignment,
    source,
    operation,
    engine: () => engineOf(assignment, artifacts),
    behavior: (inputs: readonly unknown[] = [-1, 0, 1, 10]): string => {
      const script = `import {total} from ${JSON.stringify(pathToFileURL(path.join(root, "source.ts")).href)}; console.log(JSON.stringify(${JSON.stringify(inputs)}.map(total)));`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { encoding: "utf8", timeout: TIMEOUT_MS },
      );
      if (result.status !== 0) {
        throw new Error(`fixture behavior failed: ${result.stderr}`);
      }
      return result.stdout.toString();
    },
    cli: (input: unknown): ReturnType<typeof spawnSync> => {
      function git(args: string[]): string {
        const result = spawnSync("git", args, {
          cwd: root,
          encoding: "utf8",
          timeout: TIMEOUT_MS,
        });
        if (result.status !== 0) {
          throw new Error(`fixture git failed: ${result.stderr}`);
        }
        return result.stdout.trim();
      }
      git(["init", "--initial-branch=main"]);
      git(["config", "user.name", "Refactor test"]);
      git(["config", "user.email", "refactor@example.test"]);
      git(["add", "."]);
      git(["commit", "-m", "Refactor fixture"]);
      assignment.revision = git(["rev-parse", "HEAD"]);
      const request = path.join(directory, "request.json");
      const op = path.join(directory, "operation.json");
      fs.writeFileSync(request, JSON.stringify(assignment));
      fs.writeFileSync(op, JSON.stringify(input));
      return spawnSync(
        process.execPath,
        [
          path.resolve(PIPELINE, "../../dist/safe-refactor.mjs"),
          "operation",
          "--request",
          request,
          "--artifacts",
          artifacts,
          "--operation",
          op,
        ],
        { cwd: root, encoding: "utf8", timeout: TIMEOUT_MS },
      );
    },
    cleanup: (): void => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export type { RefactorFixture };
export { fixture };
