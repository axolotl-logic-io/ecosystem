// @ts-check
// The wiki flow is gone: docs are ordinary tracked Markdown in the repo's
// docs/, changed and reviewed with the code. A config written for the wiki
// flow fails to load, naming the key to remove, instead of silently running
// without the wiki it asked for.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { testConfig } = await import("./config-test-kit.mjs");

const REMOVE_WIKI = /sets "wiki".*docs\/.*Remove "wiki" from the config/u;

for (const wiki of [true, false, null, { dir: "wiki", branch: "master" }]) {
  test(`a config with wiki ${JSON.stringify(wiki)} fails, naming the key to remove`, () => {
    assert.throws(() => testConfig({ wiki }), REMOVE_WIKI);
  });
}

test("a config without wiki loads", () => {
  const { cfg } = testConfig({});
  assert.equal("wiki" in cfg, false);
});
