// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { snapshot } from "../job/git-review-test-kit.mjs";
import {
  behavior,
  CLI,
  call,
  commitFixture,
  fixture,
  hash,
  rename,
  TIMEOUT_MS,
} from "./refactor-test-kit.mjs";

const INSPECTION = z.object({
  source: z.string(),
  text: z.string(),
  targets: z.array(z.object({ symbol: z.string() })),
  returnExpressions: z.array(z.object({ start: z.number(), end: z.number() })),
});
const EVIDENCE = z.object({
  profile: z.string(),
  backend: z.string(),
  sources: z.record(z.string(), z.string()),
  inputs: z.record(z.string(), z.string()),
  checks: z.array(
    z.object({
      name: z.string(),
      verdict: z.string(),
      diagnostics: z.array(
        z.looseObject({
          id: z.string().optional(),
          category: z.string().optional(),
        }),
      ),
    }),
  ),
});
test("valid string, array and null Biome extends retain complete non-mutating codebase evidence", () => {
  for (const extension of ["//", ["../biome.jsonc"], null]) {
    const project = fixture();
    const directory = path.join(project.root, "nested");
    fs.mkdirSync(directory);
    const policy = path.join(directory, "biome.jsonc");
    fs.writeFileSync(
      policy,
      JSON.stringify({
        root: false,
        extends: extension,
        formatter: { enabled: false },
        assist: { enabled: false },
        linter: { rules: { recommended: false } },
      }),
    );
    commitFixture(project);
    const before = snapshot(project.root);
    const result = spawnSync(
      process.execPath,
      [CLI, "check", "--request", project.request],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    assert.equal(result.status, 1, result.stderr);
    const evidence = EVIDENCE.parse(JSON.parse(result.stdout));
    assert.deepEqual(
      evidence.checks.map(({ name, verdict }) => ({ name, verdict })),
      [
        { name: "default", verdict: "passed" },
        { name: "metrics", verdict: "failed" },
        { name: "types", verdict: "passed" },
      ],
    );
    assert.equal(
      evidence.inputs[policy],
      hash(fs.readFileSync(policy, "utf8")),
    );
    assert.equal(snapshot(project.root), before);
  }
});

const STALE = /stale target/u;
const POLICY = /policy/u;
const PENDING = /pending/u;
const PURE = /pure/u;

/** @type {("ts" | "js")[]} */
const EXTENSIONS = ["ts", "js"];
for (const extension of EXTENSIONS) {
  test(`library rename preserves actual ${extension} module behavior`, () => {
    const project = fixture(extension);
    const before = behavior(project);
    const result = call(project, rename(project));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(behavior(project), before);
    const source = fs.readFileSync(
      path.join(project.root, project.file),
      "utf8",
    );
    assert.ok(source.includes("subtotal"));
    assert.ok(!source.includes("amount"));
    const checkpoints = fs
      .readdirSync(project.artifacts)
      .filter((name) => name.endsWith(".applied.json"));
    assert.equal(checkpoints.length, 1);
    assert.ok(!fs.existsSync(path.join(project.artifacts, "pending.json")));
  });

  test(`library extraction preserves actual ${extension} module behavior and records remaining metrics`, () => {
    const project = fixture(extension);
    const before = behavior(project);
    const inspected = call(project, {
      operation: "inspect",
      file: project.file,
    });
    assert.equal(inspected.status, 0, inspected.stderr);
    const inspection = INSPECTION.parse(JSON.parse(inspected.stdout));
    const [range] = inspection.returnExpressions;
    assert.ok(range);
    const result = call(project, {
      operation: "extract-function",
      target: { file: project.file, symbol: "total" },
      range,
      source: inspection.source,
      name: "adjustedSubtotal",
      rationale: "Name the subtotal adjustment as a cohesive calculation.",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(behavior(project), before);
    const source = fs.readFileSync(
      path.join(project.root, project.file),
      "utf8",
    );
    assert.ok(source.includes("function adjustedSubtotal()"), source);
    const applied = z
      .object({ evidence: EVIDENCE })
      .parse(JSON.parse(result.stdout));
    assert.ok(
      applied.evidence.checks.some(
        (entry) => entry.name === "metrics" && entry.verdict === "failed",
      ),
    );
    assert.ok(
      applied.evidence.checks.every(
        (entry) => entry.name === "metrics" || entry.verdict === "passed",
      ),
    );
  });
}

test("explicit codebase check is reproducible, non-mutating and separate from default lint", () => {
  const project = fixture();
  const before = snapshot(project.root);
  const args = [CLI, "check", "--request", project.request];
  const first = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  const second = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.equal(first.status, 1, first.stderr);
  const evidence = EVIDENCE.parse(JSON.parse(first.stdout));
  const repeated = EVIDENCE.parse(JSON.parse(second.stdout));
  assert.equal(evidence.profile, project.assignment.policy);
  assert.equal(evidence.sources[project.file], hash(project.source));
  assert.equal(evidence.backend, repeated.backend);
  assert.deepEqual(
    evidence.checks.map((entry) => ({
      name: entry.name,
      verdict: entry.verdict,
      categories: entry.diagnostics.map((diagnostic) => diagnostic.category),
    })),
    repeated.checks.map((entry) => ({
      name: entry.name,
      verdict: entry.verdict,
      categories: entry.diagnostics.map((diagnostic) => diagnostic.category),
    })),
  );
  assert.deepEqual(
    evidence.checks.map((entry) => [entry.name, entry.verdict]),
    [
      ["default", "passed"],
      ["metrics", "failed"],
      ["types", "passed"],
    ],
  );
  assert.equal(snapshot(project.root), before);
});

test("strict operation boundary refuses shell, arbitrary transforms, patches and caller-scope overrides without mutation", () => {
  const project = fixture();
  const before = snapshot(project.root);
  const valid = rename(project);
  for (const operation of [
    { operation: "shell", command: "touch escaped" },
    { operation: "apply-patch", patch: "arbitrary source" },
    { operation: "jscodeshift", transform: "module.exports = arbitrary" },
    { ...valid, root: "/tmp" },
    { ...valid, files: ["biome.jsonc"] },
    { ...valid, newText: "arbitrary source" },
    { ...valid, name: "subtotal; arbitrary()" },
    { ...valid, name: "adjustment" },
    { ...valid, target: { file: "../outside.ts", symbol: "total.amount" } },
    { ...valid, target: { file: "biome.jsonc", symbol: "total.amount" } },
    { ...valid, target: { file: project.file, symbol: "missing.amount" } },
  ]) {
    const result = call(project, operation);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.length > 0);
    assert.equal(snapshot(project.root), before);
    assert.deepEqual(fs.readdirSync(project.artifacts), []);
  }
});

test("source/config freshness failures retain source and never create an application checkpoint", () => {
  const project = fixture();
  const operation = rename(project);
  operation.source = hash("stale source");
  const result = call(project, operation);
  assert.equal(result.status, 1);
  assert.match(result.stderr, STALE);
  assert.equal(
    fs.readFileSync(path.join(project.root, project.file), "utf8"),
    project.source,
  );
  fs.appendFileSync(path.join(project.root, "metrics.jsonc"), "\n");
  commitFixture(project);
  const changedPolicy = call(project, rename(project));
  assert.equal(changedPolicy.status, 1);
  assert.match(changedPolicy.stderr, POLICY);
  assert.deepEqual(fs.readdirSync(project.artifacts), []);
});

test("symlink and hard-link source paths refuse without changing either file", () => {
  for (const kind of ["symlink", "hardlink"]) {
    const project = fixture();
    const original = path.join(project.root, project.file);
    const outside = path.join(project.directory, "outside.ts");
    fs.renameSync(original, outside);
    if (kind === "symlink") {
      fs.symlinkSync(outside, original);
    } else {
      fs.linkSync(outside, original);
    }
    const result = call(project, rename(project));
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(outside, "utf8"), project.source);
    assert.deepEqual(fs.readdirSync(project.artifacts), []);
  }
});

test("pending application is a hold, never an automatic replay", () => {
  const project = fixture();
  fs.writeFileSync(
    path.join(project.artifacts, "pending.json"),
    JSON.stringify({ operation: rename(project), before: project.source }),
  );
  const before = snapshot(project.root);
  const result = call(project, rename(project));
  assert.equal(result.status, 1);
  assert.match(result.stderr, PENDING);
  assert.equal(snapshot(project.root), before);
  assert.deepEqual(fs.readdirSync(project.artifacts), ["pending.json"]);
});

test("effectful and block-scoped extraction defer without changing actual behavior or source", () => {
  for (const { text, expression } of [
    {
      text: "export function total(amount: number): number { const adjustment = 2; return Math.abs(amount) + adjustment; }\n",
      expression: "Math.abs(amount) + adjustment",
    },
    {
      text: "export function total(amount: number): number { const adjustment = 2; if (amount > 0) { const adjustment = 5; return amount + adjustment; } return amount + adjustment; }\n",
      expression: "amount + adjustment",
    },
  ]) {
    const project = fixture();
    fs.writeFileSync(path.join(project.root, project.file), text);
    commitFixture(project);
    const before = behavior(project);
    const start = text.indexOf(expression);
    const result = call(project, {
      operation: "extract-function",
      target: { file: project.file, symbol: "total" },
      range: { start, end: start + expression.length },
      source: hash(text),
      name: "adjustedSubtotal",
      rationale:
        "Effects and block-local captures need another reviewed adapter.",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, PURE);
    assert.equal(behavior(project), before);
    assert.equal(
      fs.readFileSync(path.join(project.root, project.file), "utf8"),
      text,
    );
  }
});

test("a source-built backend inside the ignored target dist is runtime input, not a substituted source revision", () => {
  const project = fixture();
  fs.writeFileSync(path.join(project.root, ".gitignore"), "dist/\n");
  fs.writeFileSync(
    path.join(project.root, "biome.jsonc"),
    JSON.stringify({
      root: true,
      files: { includes: ["**", "!dist"] },
      formatter: { enabled: false },
      assist: { enabled: false },
      linter: { rules: { recommended: false } },
    }),
  );
  commitFixture(project);
  const output = path.join(project.root, "dist");
  const build = fileURLToPath(new URL("../../build.ts", import.meta.url));
  const built = spawnSync(process.execPath, [build, output], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.equal(built.status, 0, built.stderr);
  const operation = path.join(project.directory, "single-operation.json");
  fs.writeFileSync(operation, JSON.stringify(rename(project)));
  const before = behavior(project);
  const result = spawnSync(
    process.execPath,
    [
      path.join(output, "safe-refactor.mjs"),
      "operation",
      "--request",
      project.request,
      "--artifacts",
      project.artifacts,
      "--operation",
      operation,
    ],
    { encoding: "utf8", timeout: TIMEOUT_MS },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(behavior(project), before);
  assert.ok(
    fs
      .readFileSync(path.join(project.root, project.file), "utf8")
      .includes("subtotal"),
  );
});
