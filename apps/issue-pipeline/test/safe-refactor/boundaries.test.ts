import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { git, snapshot } from "../job/git-review-test-kit.ts";
import {
  behavior,
  CLI,
  call,
  commitFixture,
  fixture,
  rename,
  TIMEOUT_MS,
} from "./refactor-test-kit.ts";

const CHECKPOINT = z.object({
  edits: z.array(z.object({ before: z.string(), after: z.string() })).length(1),
});
const SHORT_WRITE = `import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";
const target=fs.statSync(process.env.FAIL_SOURCE); const original=fs.writeSync;
fs.writeSync=(fd,buffer,offset,length,position)=>{
 const opened=fs.fstatSync(fd);
 if(opened.ino===target.ino && opened.dev===target.dev && Buffer.isBuffer(buffer)) return original(fd,buffer,offset,length-1,position);
 return original(fd,buffer,offset,length,position);
};syncBuiltinESMExports();`;

test("language-service rename retains a shorthand object's public property and actual module behavior", () => {
  const project = fixture();
  const file = path.join(project.root, project.file);
  fs.writeFileSync(
    file,
    "export function total(amount: number): {amount: number} {\n  return {amount};\n}\n",
  );
  commitFixture(project);
  const before = behavior(project);
  const result = call(project, rename(project));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(behavior(project), before);
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes("amount: subtotal"));
});

test("parameter properties and dynamic scope defer rather than changing a public API or eval behavior", () => {
  const scenarios = [
    {
      source:
        "export class Account { constructor(public amount: number) {} }\n",
      symbol: "Account.amount",
    },
    {
      source:
        'export function total(amount: number): number { eval("amount"); return amount; }\n',
      symbol: "total.amount",
    },
  ];
  for (const scenario of scenarios) {
    const project = fixture();
    const file = path.join(project.root, project.file);
    fs.writeFileSync(file, scenario.source);
    commitFixture(project);
    const operation = {
      ...rename(project),
      target: { file: project.file, symbol: scenario.symbol },
    };
    const result = call(project, operation);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(fs.readFileSync(file, "utf8"), scenario.source);
    assert.equal(fs.readdirSync(project.artifacts).length, 0);
  }
});

test("a real existing TypeScript error blocks mutation rather than becoming refactoring validation evidence", () => {
  const project = fixture();
  const file = path.join(project.root, project.file);
  const source =
    "export function total(amount: number): number { return amount + missing; }\n";
  fs.writeFileSync(file, source);
  commitFixture(project);
  const result = call(project, rename(project));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes("baseline is not clear"));
  assert.equal(fs.readFileSync(file, "utf8"), source);
  assert.equal(fs.readdirSync(project.artifacts).length, 0);
});

test("paginated project reading is non-mutating and cannot read protected environment files", () => {
  const project = fixture();
  const text = "# Design\nUse the accepted domain language.\n";
  const offset = 2;
  const limit = 6;
  fs.writeFileSync(path.join(project.root, "README.md"), text);
  fs.writeFileSync(
    path.join(project.root, ".env.fixture.ts"),
    'export const value = "private-test-value";\n',
  );
  const result = call(project, {
    operation: "read",
    file: "README.md",
    offset,
    limit,
  });
  assert.equal(result.status, 0, result.stderr);
  const page = z
    .object({
      text: z.string(),
      offset: z.number(),
      totalCharacters: z.number(),
    })
    .parse(JSON.parse(result.stdout));
  assert.equal(page.text, text.slice(offset, offset + limit));
  assert.equal(page.offset, offset);
  assert.equal(page.totalCharacters, text.length);
  const refused = call(project, { operation: "read", file: ".env.fixture.ts" });
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(
    `${refused.stdout}${refused.stderr}`.includes("private-test-value"),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(project.root, "README.md"), "utf8"),
    text,
  );
});

test("a real partial source write retains its durable checkpoint and cannot be replayed", () => {
  const project = fixture();
  const file = path.join(project.root, project.file);
  const before = fs.readFileSync(file, "utf8");
  const preload = path.join(project.directory, "short-write.mjs");
  const operation = path.join(project.directory, "partial-operation.json");
  fs.writeFileSync(preload, SHORT_WRITE);
  fs.writeFileSync(operation, JSON.stringify(rename(project)));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      CLI,
      "operation",
      "--request",
      project.request,
      "--artifacts",
      project.artifacts,
      "--operation",
      operation,
    ],
    {
      env: Object.fromEntries([
        ...Object.entries(process.env),
        ["FAIL_SOURCE", file],
      ]),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes("short source write"), result.stderr);
  const pending = path.join(project.artifacts, "pending.json");
  const checkpoint = CHECKPOINT.parse(
    JSON.parse(fs.readFileSync(pending, "utf8")),
  );
  const [edit] = checkpoint.edits;
  assert.ok(edit);
  assert.equal(edit.before, before);
  const partial = fs.readFileSync(file, "utf8");
  assert.equal(partial, edit.after.slice(0, -1));
  assert.notEqual(partial, before);
  const repeat = call(project, rename(project));
  assert.equal(repeat.status, 1, repeat.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), partial);
  assert.deepEqual(fs.readdirSync(project.artifacts), ["pending.json"]);
});

test("the actual compiler cannot follow read-only source symlinks or hard links outside assignment scope", () => {
  for (const kind of ["symlink", "hardlink"]) {
    const project = fixture();
    const outside = path.join(project.directory, "private-input.ts");
    const dependency = path.join(project.root, "dependency.ts");
    const source =
      'import { offset } from "./dependency.js";\nexport function total(amount: number): number { return amount + offset; }\n';
    const text = "export const offset = 2;\n";
    fs.writeFileSync(outside, text);
    fs.writeFileSync(path.join(project.root, project.file), source);
    if (kind === "symlink") {
      fs.symlinkSync(outside, dependency);
    } else {
      fs.linkSync(outside, dependency);
    }
    const result = spawnSync(
      process.execPath,
      [CLI, "check", "--request", project.request],
      { encoding: "utf8", timeout: TIMEOUT_MS },
    );
    assert.equal(result.status, 1, result.stdout);
    assert.ok(
      result.stderr.includes("compiler inputs must be canonical"),
      result.stderr,
    );
    assert.equal(fs.readFileSync(outside, "utf8"), text);
    assert.equal(
      fs.readFileSync(path.join(project.root, project.file), "utf8"),
      source,
    );
  }
});

test("a caller must explicitly select the reviewed behavior contract; stronger preservation is never silently downgraded", () => {
  const project = fixture();
  fs.writeFileSync(
    project.request,
    JSON.stringify({
      ...project.assignment,
      behavior: "all-javascript-observations",
    }),
  );
  const before = snapshot(project.root);
  const result = call(project, rename(project));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes("js-values-effects-v1"), result.stderr);
  assert.equal(snapshot(project.root), before);
});

test("index-only differences refuse an exact-revision mutation without writing the original index", () => {
  const project = fixture();
  const readme = path.join(project.root, "README.md");
  fs.writeFileSync(readme, "Original guidance.\n");
  commitFixture(project);
  fs.writeFileSync(readme, "Staged changed guidance.\n");
  git(project.root, ["add", "README.md"]);
  fs.writeFileSync(readme, "Original guidance.\n");
  const before = snapshot(project.root);
  const result = call(project, rename(project));
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.includes("clean checkout"), result.stderr);
  assert.equal(snapshot(project.root), before);
  assert.deepEqual(fs.readdirSync(project.artifacts), []);
});

test("prototype-sensitive shorthand refuses before writing and retains observable own-property behavior", () => {
  const project = fixture();
  const source =
    "export function total(amount: number) { const __proto__ = amount; return { __proto__ }; }\n";
  fs.writeFileSync(path.join(project.root, project.file), source);
  commitFixture(project);
  const before = behavior(project);
  const result = call(project, {
    ...rename(project),
    target: { file: project.file, symbol: "total.__proto__" },
    name: "renamedProto",
  });
  assert.equal(result.status, 1, result.stdout);
  assert.equal(behavior(project), before);
  assert.equal(
    fs.readFileSync(path.join(project.root, project.file), "utf8"),
    source,
  );
});

test("non-strict JavaScript implicit arguments bindings refuse with actual script behavior unchanged", () => {
  const project = fixture("js");
  const source =
    "/** @param {number} arguments */\nfunction total(arguments) { const adjustment = 2; return arguments + adjustment; }\n";
  fs.writeFileSync(path.join(project.root, project.file), source);
  fs.writeFileSync(
    path.join(project.root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: false,
        noEmit: true,
        allowJs: true,
        checkJs: true,
      },
      files: [project.file],
    }),
  );
  commitFixture(project);
  function observation(): string {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "--eval",
        `${fs.readFileSync(path.join(project.root, project.file), "utf8")}\nconsole.log(JSON.stringify([-1, 1].map(total)));`,
      ],
      { cwd: project.root, encoding: "utf8", timeout: TIMEOUT_MS },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const before = observation();
  const start = source.indexOf("arguments + adjustment");
  for (const operation of [
    {
      ...rename(project),
      target: { file: project.file, symbol: "total.arguments" },
    },
    {
      operation: "extract-function",
      target: { file: project.file, symbol: "total" },
      source: rename(project).source,
      range: { start, end: start + "arguments + adjustment".length },
      name: "adjustedSubtotal",
      rationale: "Implicit arguments must not be rebound to a helper.",
    },
  ]) {
    const result = call(project, operation);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(observation(), before);
    assert.equal(
      fs.readFileSync(path.join(project.root, project.file), "utf8"),
      source,
    );
  }
});
