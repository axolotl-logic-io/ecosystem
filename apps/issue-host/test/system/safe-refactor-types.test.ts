import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import safeRefactor, {
  type ExtensionApi,
  type Tool,
} from "../../src/safe-refactor/tool.ts";
import { fixture } from "../support/safe-refactor-test-kit.ts";

const CHECKPOINT = z.looseObject({ checkpoint: z.string() });
const BLOCKED = z.looseObject({ block: z.literal(true) });

test("the built Refactor CLI introduces an interface with an atomic annotation edit", () => {
  const box = fixture({
    "source.ts":
      "export function total(input: { amount: number }): number {\n  return input.amount + 1;\n}\n",
  });
  try {
    const result = box.cli(
      box.operation("introduce-type", "CounterInput", {
        declaration: "interface CounterInput { amount: number; }",
        annotations: [{ symbol: "total.input", type: "CounterInput" }],
      }),
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const applied = CHECKPOINT.parse(JSON.parse(result.stdout.toString()));
    assert.ok(fs.existsSync(path.join(box.artifacts, applied.checkpoint)));
    assert.ok(box.source().includes("input: CounterInput"));
    assert.ok(box.source().includes("interface CounterInput"));
    assert.equal(box.behavior([{ amount: 0 }, { amount: 2 }]), "[1,3]\n");
  } finally {
    box.cleanup();
  }
});

test("the built Refactor CLI rejects executable declaration text without writes", () => {
  const box = fixture();
  try {
    const before = box.source();
    const result = box.cli(
      box.operation("introduce-type", "Count", {
        declaration: "type Count = number; process.exit(0);",
        annotations: [{ symbol: "total.amount", type: "Count" }],
      }),
    );
    assert.equal(result.status, 1, result.stdout.toString());
    assert.ok(
      result.stderr.toString().includes("exactly one alias"),
      result.stderr.toString(),
    );
    assert.equal(box.source(), before);
    assert.deepEqual(fs.readdirSync(box.artifacts), []);
  } finally {
    box.cleanup();
  }
});

test("the restricted extension exposes type operations but no general editor", async () => {
  const box = fixture();
  const previous = process.env;
  const tools = new Map<string, Tool>();
  const starts: (() => void)[] = [];
  const stops: (() => void)[] = [];
  const blocks: ((name: string) => unknown)[] = [];
  let active: string[] = [];
  function on(event: string, handler: unknown): undefined {
    if (typeof handler === "function") {
      if (event === "session_start") {
        starts.push(() => handler());
      } else if (event === "session_shutdown") {
        stops.push(() => handler());
      } else if (event === "tool_call") {
        blocks.push((name: string): unknown => handler({ toolName: name }));
      }
    }
  }
  const api: ExtensionApi = {
    on,
    registerTool: (tool: Tool): void => {
      tools.set(tool.name, tool);
    },
    setActiveTools: (names: string[]): void => {
      active = names;
    },
  };
  try {
    fs.writeFileSync(
      path.join(box.artifacts, "assignment.json"),
      JSON.stringify(box.assignment),
    );
    process.env = Object.fromEntries([
      ...Object.entries(previous),
      ["SAFE_REFACTOR_RUN", box.artifacts],
    ]);
    safeRefactor(api);
    assert.equal(starts.length, 1);
    starts[0]?.();
    assert.deepEqual(active, ["safe_refactor", "safe_refactor_finish"]);
    assert.deepEqual([...tools.keys()], active);
    const tool = tools.get("safe_refactor");
    assert.ok(tool !== undefined);
    const schema = JSON.stringify(tool.parameters);
    for (const name of [
      "introduce-type",
      "modify-type",
      "remove-type",
      "set-type-annotation",
      "remove-type-annotation",
    ]) {
      assert.ok(schema.includes(name), name);
    }
    assert.equal(BLOCKED.parse(blocks[0]?.("write")).block, true);
    await tool.execute(
      "annotation",
      box.operation("set-type-annotation", "total", { type: "number | 0" }),
    );
    assert.ok(box.source().includes(": number | 0"));
    const before = box.source();
    await assert.rejects(async () => {
      await tool.execute(
        "arbitrary",
        box.operation("modify-type", "total", {
          declaration: "type total = number;",
          replacement: "executable source",
        }),
      );
    });
    assert.equal(box.source(), before);
  } finally {
    for (const stop of stops) {
      stop();
    }
    process.env = previous;
    box.cleanup();
  }
});
