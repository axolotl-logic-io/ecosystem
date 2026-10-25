// repos/example.json, the config the install copies, sets only fields the
// pipeline reads: it loads with no removed field and no legacy model role to
// warn about, names the three model roles' models, and caps the author and
// review stages. The pipeline root is a temporary one before src/ loads.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { isolatedOpsFixture } from "./integration-source-test-kit.ts";

await isolatedOpsFixture("integration-source-example-config");
const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { withoutRemovedKeys }: typeof import("../src/config-legacy.ts") =
  await import("../src/config-legacy.ts");

const EXAMPLE: string = new URL("../repos/example.json", import.meta.url)
  .pathname;

test("the example config loads with nothing to warn about", () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
  const { warnings } = withoutRemovedKeys(raw);
  assert.deepEqual(warnings, []);
  const cfg = loadConfig(EXAMPLE);
  assert.deepEqual(Object.keys(raw.models), [
    "author",
    "implementor",
    "reviewer",
  ]);
  assert.deepEqual(cfg.models, raw.models);
  assert.deepEqual(raw.stageCaps, { author: 2, review: 2 });
});
