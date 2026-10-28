import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { Engine } from "../../../src/safe-refactor/engine.ts";
import {
  fixture,
  type RefactorFixture,
} from "../../support/safe-refactor-test-kit.ts";

const HASH_HEX_LENGTH = 64;
const APPLIED = z.looseObject({
  checkpoint: z.string(),
  evidence: z.looseObject({
    checks: z.array(z.looseObject({ name: z.string(), verdict: z.string() })),
  }),
});
const INSPECTION = z.looseObject({
  text: z.string(),
  operations: z.array(z.string()),
  targets: z.array(z.looseObject({ symbol: z.string() })),
});
const OBJECT_COUNTER =
  "export function total(input: { amount: number }): number {\n  return input.amount + 1;\n}\n";
const NULLABLE_COUNTER =
  "type Count = number | undefined;\n\nexport function total(amount: Count): number {\n  return (amount ?? 0) + 1;\n}\n";

function refusal(
  box: RefactorFixture,
  engine: Engine,
  input: unknown,
  file = "source.ts",
): {
  error: string;
  before: string;
  after: string;
  artifactsBefore: string[];
  artifactsAfter: string[];
} {
  const before = box.source(file);
  const artifactsBefore = fs.readdirSync(box.artifacts);
  let error = "";
  try {
    engine.execute(input);
  } catch (caught: unknown) {
    if (caught instanceof Error) {
      error = caught.message;
    } else {
      error = String(caught);
    }
  }
  return {
    error,
    before,
    after: box.source(file),
    artifactsBefore,
    artifactsAfter: fs.readdirSync(box.artifacts),
  };
}

test("existing local rename still preserves runtime behavior after shared target helpers change", () => {
  const box = fixture();
  const engine = box.engine();
  try {
    const before = box.behavior();
    const result = APPLIED.parse(
      engine.execute(
        box.operation("rename-symbol", "total.amount", { name: "subtotal" }),
      ),
    );
    assert.ok(box.source().includes("total(subtotal: number)"));
    assert.equal(box.behavior(), before);
    assert.ok(
      result.evidence.checks.every((check) => check.verdict === "passed"),
    );
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("existing pure-expression extraction still uses the compiler's refactor edits", () => {
  const box = fixture({
    "source.ts":
      "export function total(amount: number): number {\n  const adjustment = 2;\n  return amount > 0 ? amount * adjustment : amount + adjustment;\n}\n",
  });
  const engine = box.engine();
  try {
    const before = box.behavior();
    const inspected = z
      .looseObject({
        returnExpressions: z.array(
          z.strictObject({ start: z.number(), end: z.number() }),
        ),
      })
      .parse(engine.execute({ operation: "inspect", file: "source.ts" }));
    const [range] = inspected.returnExpressions;
    assert.ok(range !== undefined);
    const result = APPLIED.parse(
      engine.execute(
        box.operation("extract-function", "total", {
          range,
          name: "adjustedCount",
        }),
      ),
    );
    assert.ok(box.source().includes("function adjustedCount"));
    assert.equal(box.behavior(), before);
    assert.ok(
      result.evidence.checks.some(
        (check) => check.name === "types" && check.verdict === "passed",
      ),
    );
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("named aliases can be introduced, modified and removed atomically with their uses", () => {
  const box = fixture();
  const engine = box.engine();
  try {
    const before = box.behavior();
    const added = APPLIED.parse(
      engine.execute(
        box.operation("introduce-type", "Count", {
          declaration: "type Count = number;",
          annotations: [{ symbol: "total.amount", type: "Count" }],
        }),
      ),
    );
    assert.ok(fs.existsSync(path.join(box.artifacts, added.checkpoint)));
    assert.ok(!fs.existsSync(path.join(box.artifacts, "pending.json")));
    assert.ok(
      added.evidence.checks.every((check) => check.verdict === "passed"),
    );
    assert.ok(box.source().includes("amount: Count"));
    assert.equal(box.behavior(), before);
    const inspected = INSPECTION.parse(
      engine.execute({ operation: "inspect", file: "source.ts" }),
    );
    assert.ok(inspected.targets.some((target) => target.symbol === "Count"));
    assert.ok(inspected.operations.includes("modify-type"));
    engine.execute(
      box.operation("modify-type", "Count", {
        declaration: "type Count = 0 | 1 | 2;",
      }),
    );
    assert.ok(box.source().includes("type Count = 0 | 1 | 2;"));
    assert.equal(box.behavior(), before);
    engine.execute(
      box.operation("remove-type", "Count", {
        annotations: [{ symbol: "total.amount", type: "number" }],
      }),
    );
    assert.ok(!box.source().includes("Count"));
    assert.equal(box.behavior(), before);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("interfaces can be introduced, extended and removed without changing counter behavior", () => {
  const box = fixture({ "source.ts": OBJECT_COUNTER });
  const engine = box.engine();
  try {
    const inputs = [{ amount: -1 }, { amount: 0 }, { amount: 2 }];
    const before = box.behavior(inputs);
    engine.execute(
      box.operation("introduce-type", "CounterInput", {
        declaration: "interface CounterInput { amount: number; }",
        annotations: [{ symbol: "total.input", type: "CounterInput" }],
      }),
    );
    engine.execute(
      box.operation("modify-type", "CounterInput", {
        declaration:
          "interface CounterInput { amount: number; label?: string; }",
      }),
    );
    assert.ok(box.source().includes("label?: string"));
    engine.execute(
      box.operation("remove-type", "CounterInput", {
        annotations: [
          { symbol: "total.input", type: "{ amount: number; label?: string }" },
        ],
      }),
    );
    assert.ok(!box.source().includes("CounterInput"));
    assert.equal(box.behavior(inputs), before);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("a type definition can change shape while every project consumer still typechecks", () => {
  const box = fixture({ "source.ts": NULLABLE_COUNTER });
  const engine = box.engine();
  try {
    const before = box.behavior([null, 0, 1]);
    engine.execute(
      box.operation("modify-type", "Count", {
        declaration: "type Count = number | null | undefined;",
      }),
    );
    assert.ok(box.source().includes("number | null | undefined"));
    assert.equal(box.behavior([null, 0, 1]), before);
    {
      const refused = refusal(
        box,
        engine,
        box.operation("remove-type", "Count"),
      );
      assert.ok(refused.error.includes("type/syntax errors"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
    {
      const refused = refusal(
        box,
        engine,
        box.operation("modify-type", "Count", {
          declaration: "type Other = number;",
        }),
      );
      assert.ok(refused.error.includes("requested name"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("variable and function-return annotations can be added, modified and removed", () => {
  const box = fixture({
    "source.ts":
      "export function total(amount: number): number {\n  const adjustment = 1;\n  return amount + adjustment;\n}\n",
  });
  const engine = box.engine();
  try {
    const before = box.behavior();
    engine.execute(
      box.operation("set-type-annotation", "total.adjustment", {
        type: "number",
      }),
    );
    assert.ok(box.source().includes("adjustment: number"));
    engine.execute(
      box.operation("set-type-annotation", "total.adjustment", { type: "1" }),
    );
    engine.execute(box.operation("remove-type-annotation", "total.adjustment"));
    engine.execute(box.operation("remove-type-annotation", "total"));
    engine.execute(
      box.operation("set-type-annotation", "total", { type: "number" }),
    );
    assert.equal(box.behavior(), before);
    {
      const refused = refusal(
        box,
        engine,
        box.operation("remove-type-annotation", "total.amount"),
      );
      assert.ok(refused.error.includes("type/syntax errors"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
    {
      const refused = refusal(
        box,
        engine,
        box.operation("set-type-annotation", "total.adjustment", {
          type: "string",
        }),
      );
      assert.ok(refused.error.includes("type/syntax errors"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("function initializers expose a separate checked return-annotation slot", () => {
  const box = fixture({
    "source.ts": "export const total = (amount: number) => amount + 1;\n",
  });
  const engine = box.engine();
  try {
    const before = box.behavior();
    engine.execute(
      box.operation("set-type-annotation", "total", {
        slot: "return",
        type: "number",
      }),
    );
    assert.ok(box.source().includes("(amount: number): number =>"));
    engine.execute(
      box.operation("remove-type-annotation", "total", { slot: "return" }),
    );
    engine.execute(
      box.operation("set-type-annotation", "total", {
        type: "(amount: number) => number",
      }),
    );
    assert.equal(box.behavior(), before);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("generic type declarations and return predicates stay inside the type-only interface", () => {
  const box = fixture({
    "source.ts":
      'export function total(value: unknown): boolean {\n  return typeof value === "number";\n}\n',
  });
  const engine = box.engine();
  try {
    const before = box.behavior([0, "counter", null]);
    engine.execute(
      box.operation("introduce-type", "CounterValue", {
        declaration: "type CounterValue<T> = T | undefined;",
        annotations: [{ symbol: "total.value", type: "CounterValue<unknown>" }],
      }),
    );
    engine.execute(
      box.operation("set-type-annotation", "total", {
        type: "value is number",
      }),
    );
    assert.ok(box.source().includes("value is number"));
    assert.equal(box.behavior([0, "counter", null]), before);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("class fields and method parameters and returns expose qualified annotation targets", () => {
  const box = fixture({
    "source.ts":
      "export class Counter {\n  value = 1;\n  total(amount: number) {\n    return amount + this.value;\n  }\n}\n",
  });
  const engine = box.engine();
  try {
    const inspected = INSPECTION.parse(
      engine.execute({ operation: "inspect", file: "source.ts" }),
    );
    for (const symbol of [
      "Counter.value",
      "Counter.total",
      "Counter.total.amount",
    ]) {
      assert.ok(
        inspected.targets.some((target) => target.symbol === symbol),
        symbol,
      );
    }
    engine.execute(
      box.operation("set-type-annotation", "Counter.value", { type: "number" }),
    );
    engine.execute(
      box.operation("set-type-annotation", "Counter.total", { type: "number" }),
    );
    engine.execute(
      box.operation("set-type-annotation", "Counter.total.amount", {
        type: "0 | 1 | 2",
      }),
    );
    engine.execute(box.operation("remove-type-annotation", "Counter.value"));
    assert.ok(box.source().includes("total(amount: 0 | 1 | 2): number"));
    assert.ok(box.source().includes("value = 1;"));
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("a failed projected check restores the overlay before a later valid request", () => {
  const box = fixture();
  const engine = box.engine();
  try {
    const before = box.source();
    assert.throws(() =>
      engine.execute(
        box.operation("set-type-annotation", "total.amount", { type: "any" }),
      ),
    );
    const inspected = INSPECTION.parse(
      engine.execute({ operation: "inspect", file: "source.ts" }),
    );
    assert.equal(inspected.text, before);
    engine.execute(box.operation("remove-type-annotation", "total"));
    assert.ok(!box.source().includes("): number"));
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("pending writes and changed consulted inputs retain the existing refusal boundary", () => {
  const box = fixture();
  const engine = box.engine();
  try {
    const before = box.source();
    const pending = path.join(box.artifacts, "pending.json");
    fs.writeFileSync(pending, "{}\n");
    assert.throws(() =>
      engine.execute(box.operation("remove-type-annotation", "total")),
    );
    assert.equal(box.source(), before);
    assert.equal(fs.readFileSync(pending, "utf8"), "{}\n");
    fs.unlinkSync(pending);
    const glossary = path.join(box.root, "GLOSSARY.md");
    fs.appendFileSync(
      glossary,
      "\nA changed definition requires a new assignment.\n",
    );
    assert.throws(() =>
      engine.execute(box.operation("remove-type-annotation", "total")),
    );
    assert.equal(box.source(), before);
    assert.deepEqual(fs.readdirSync(box.artifacts), []);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("projected checks refuse an explicitly assigned file excluded by checker policy", () => {
  const box = fixture(undefined, {}, undefined, {
    files: { includes: ["**", "!source.ts"] },
  });
  const engine = box.engine();
  try {
    const refused = refusal(
      box,
      engine,
      box.operation("set-type-annotation", "total.amount", {
        type: "number | 0",
      }),
    );
    assert.ok(refused.error.includes("projected"), refused.error);
    assert.equal(refused.after, refused.before);
    assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("type operations refuse JavaScript targets without changing their JSDoc or runtime", () => {
  const box = fixture({
    "source.js":
      "/** @param {number} amount */\nexport function total(amount) {\n  return amount + 1;\n}\n",
  });
  const engine = box.engine();
  try {
    const refused = refusal(
      box,
      engine,
      box.operation(
        "set-type-annotation",
        "total.amount",
        { type: "number" },
        "source.js",
      ),
      "source.js",
    );
    assert.ok(
      refused.error.includes("TypeScript implementation"),
      refused.error,
    );
    assert.equal(refused.after, refused.before);
    assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

const INVALID_TYPES: {
  name: string;
  operation: string;
  symbol: string;
  fields: Record<string, unknown>;
  reason: string;
}[] = [
  {
    name: "extra executable statements",
    operation: "introduce-type",
    symbol: "Count",
    fields: { declaration: "type Count = number; globalThis.changed = true;" },
    reason: "exactly one alias",
  },
  {
    name: "runtime declarations",
    operation: "introduce-type",
    symbol: "Count",
    fields: { declaration: "class Count {}" },
    reason: "exactly one alias",
  },
  {
    name: "runtime enums",
    operation: "introduce-type",
    symbol: "Count",
    fields: { declaration: "enum Count { One }" },
    reason: "exactly one alias",
  },
  {
    name: "renamed declarations",
    operation: "introduce-type",
    symbol: "Count",
    fields: { declaration: "type Other = number;" },
    reason: "requested name",
  },
  {
    name: "annotation injection",
    operation: "set-type-annotation",
    symbol: "total.amount",
    fields: { type: "number; globalThis.changed = true" },
    reason: "exactly one type",
  },
  {
    name: "typecheck directives",
    operation: "set-type-annotation",
    symbol: "total.amount",
    fields: { type: "number /* @ts-ignore */" },
    reason: "comments and directives",
  },
  {
    name: "malformed types",
    operation: "set-type-annotation",
    symbol: "total.amount",
    fields: { type: "{ value:" },
    reason: "invalid type syntax",
  },
  {
    name: "default-lint failures",
    operation: "set-type-annotation",
    symbol: "total.amount",
    fields: { type: "any" },
    reason: "default Biome checks",
  },
  {
    name: "type name capture",
    operation: "introduce-type",
    symbol: "total",
    fields: { declaration: "type total = number;" },
    reason: "already occurs",
  },
];
for (const entry of INVALID_TYPES) {
  test(`type edits refuse ${entry.name} without writes or checkpoints`, () => {
    const box = fixture();
    const engine = box.engine();
    try {
      {
        const refused = refusal(
          box,
          engine,
          box.operation(entry.operation, entry.symbol, entry.fields),
        );
        assert.ok(refused.error.includes(entry.reason), refused.error);
        assert.equal(refused.after, refused.before);
        assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
      }
    } finally {
      engine.dispose();
      box.cleanup();
    }
  });
}

test("stale hashes, unknown arguments and out-of-scope files still refuse type edits", () => {
  const box = fixture(
    {
      "source.ts": NULLABLE_COUNTER,
      "other.ts": "export type Other = number;\n",
    },
    {},
    ["source.ts"],
  );
  const engine = box.engine();
  try {
    {
      const refused = refusal(
        box,
        engine,
        box.operation("modify-type", "Count", {
          declaration: "type Count = number;",
          source: "0".repeat(HASH_HEX_LENGTH),
        }),
      );
      assert.ok(refused.error.includes("stale target"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
    {
      const refused = refusal(
        box,
        engine,
        box.operation("modify-type", "Count", {
          declaration: "type Count = number;",
          replacement: "arbitrary code",
        }),
      );
      assert.ok(refused.error.includes("Unrecognized key"), refused.error);
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
    {
      const refused = refusal(
        box,
        engine,
        box.operation(
          "modify-type",
          "Other",
          { declaration: "type Other = string;" },
          "other.ts",
        ),
        "other.ts",
      );
      assert.ok(
        refused.error.includes("outside assigned write scope"),
        refused.error,
      );
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("type-only exports that alter a script's emitted module behavior refuse", () => {
  const box = fixture({ "source.ts": "Math.random();\n" });
  const engine = box.engine();
  try {
    {
      const refused = refusal(
        box,
        engine,
        box.operation("introduce-type", "Count", {
          declaration: "export type Count = number;",
        }),
      );
      assert.ok(
        refused.error.includes("changes emitted JavaScript"),
        refused.error,
      );
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("NodeNext module format is retained by the emission probe", () => {
  const box = fixture(
    {
      "source.ts":
        "export function total(amount: number): number {\n  return amount + 1;\n}\n",
      "package.json": '{"type":"module"}\n',
    },
    { module: "NodeNext", moduleResolution: "NodeNext" },
    ["source.ts"],
  );
  const engine = box.engine();
  try {
    const before = box.behavior();
    const result = APPLIED.parse(
      engine.execute(
        box.operation("set-type-annotation", "total.amount", {
          type: "number | 0",
        }),
      ),
    );
    assert.equal(box.behavior(), before);
    assert.ok(
      result.evidence.checks.every((check) => check.verdict === "passed"),
    );
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("package export maps remain resolved when checking decorator metadata", () => {
  const box = fixture(
    {
      "source.ts":
        'import type { First, Second } from "type-box";\n\nexport type Value = First;\nexport type Reserve = First | Second;\n',
      "consumer.ts":
        'import type { Value } from "./source.ts";\n\nfunction decorate(_target: object, _key: string): void { Object.freeze(_target); }\n\nexport class Counter {\n  @decorate\n  value!: Value;\n}\n',
      "node_modules/type-box/package.json":
        '{"name":"type-box","type":"module","exports":{".":{"types":"./spec/types.d.ts"}}}',
      "node_modules/type-box/spec/types.d.ts":
        "export type First = number;\nexport type Second = string;\n",
    },
    {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
    },
    ["source.ts"],
  );
  const engine = box.engine();
  try {
    const consumer = box.source("consumer.ts");
    const refused = refusal(
      box,
      engine,
      box.operation("modify-type", "Value", {
        declaration: "export type Value = Second;",
      }),
    );
    assert.ok(
      refused.error.includes("changes emitted JavaScript"),
      refused.error,
    );
    assert.equal(refused.after, refused.before);
    assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    assert.equal(box.source("consumer.ts"), consumer);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});

test("a type change that changes decorator metadata in an unassigned consumer refuses", () => {
  const box = fixture(
    {
      "source.ts": "export type Value = number;\n",
      "consumer.ts":
        'import type { Value } from "./source.ts";\n\nfunction decorate(_target: object, _key: string): void { Object.freeze(_target); }\n\nexport class Counter {\n  @decorate\n  value!: Value;\n}\n',
    },
    {
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
    },
    ["source.ts"],
  );
  const engine = box.engine();
  try {
    const consumer = box.source("consumer.ts");
    {
      const refused = refusal(
        box,
        engine,
        box.operation("modify-type", "Value", {
          declaration: "export type Value = string;",
        }),
      );
      assert.ok(
        refused.error.includes("changes emitted JavaScript"),
        refused.error,
      );
      assert.equal(refused.after, refused.before);
      assert.deepEqual(refused.artifactsAfter, refused.artifactsBefore);
    }
    assert.equal(box.source("consumer.ts"), consumer);
  } finally {
    engine.dispose();
    box.cleanup();
  }
});
