// Built standalone launcher, real task subprocesses and fake GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  apply,
  issueOf,
  machine,
  marked,
} from "../../support/task-app/task-app-test-kit.ts";

const SAMPLE = path.resolve(
  import.meta.dirname,
  "../../support/task-app/sample-task-app.ts",
);
const MANIFEST_ERROR = /manifest|registration|version/u;
const ACCOUNT_ERROR = /cannot verify the credential/u;

test("discovery executes an arbitrary registered program without a buddy file or inherited credentials", async () => {
  const box = machine(undefined, {
    environment: new Map([
      ["GH_TOKEN", "ambient-token"],
      ["HIPPY_GITHUB_TOKEN", "ambient-private-token"],
    ]),
  });
  try {
    box.install("gherkin");
    const buddy = box.buddyFile("hippy");
    const worker = path.join(box.pipeline, "registered-worker.mjs");
    const receipt = path.join(box.root, "child.json");
    fs.writeFileSync(
      worker,
      `
      import fs from "node:fs";
      fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args: process.argv.slice(2), github: process.env.GH_TOKEN, privateToken: process.env.HIPPY_GITHUB_TOKEN }));
      fs.unlinkSync(${JSON.stringify(buddy)});
      await import(${JSON.stringify(pathToFileURL(SAMPLE).href)});
    `,
    );
    fs.writeFileSync(
      path.join(box.pipeline, "tasks.json"),
      JSON.stringify({
        version: 1,
        tasks: [{ id: "gherkin", executable: "registered-worker.mjs" }],
      }),
    );
    const run = box.launch("hippy", { tasks: ["gherkin"] });
    const exit = await run.exit((item) => item.task === "gherkin");
    assert.equal(exit.exit, 0);
    assert.equal((await run.stop()).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, "utf8")), {
      args: ["--invocation"],
    });
    assert.equal(fs.existsSync(buddy), false);
    assert.equal(marked(box.world(), "note").length, 1);
  } finally {
    box.cleanup();
  }
});

const INVALID_MANIFESTS = [
  { name: "unsupported version", manifest: { version: 2, tasks: [] } },
  { name: "missing registration", manifest: { version: 1, tasks: [] } },
  {
    name: "duplicate registration",
    manifest: {
      version: 1,
      tasks: [
        { id: "gherkin", executable: "gherkin.mjs" },
        { id: "gherkin", executable: "gherkin.mjs" },
      ],
    },
  },
];
for (const { name, manifest } of INVALID_MANIFESTS) {
  test(`${name} refuses startup before GitHub effects`, async () => {
    const box = machine();
    try {
      box.install("gherkin");
      fs.writeFileSync(
        path.join(box.pipeline, "tasks.json"),
        JSON.stringify(manifest),
      );
      const end = await box.launch("hippy", { tasks: ["gherkin"] }).exited;
      assert.equal(end.status, 1);
      assert.match(end.stderr, MANIFEST_ERROR);
      assert.equal(issueOf(box.world()).comments.length, 0);
      assert.ok(issueOf(box.world()).labels.includes("start:gherkin"));
      assert.equal(fs.existsSync(path.join(box.pipeline, "runs")), false);
    } finally {
      box.cleanup();
    }
  });
}

test("an account mismatch prevents discovery and claims", async () => {
  const box = machine((world) => {
    world.tokens = [{ token: "dev-token", login: "another-account" }];
  });
  try {
    box.install("gherkin");
    const end = await box.launch("hippy", { tasks: ["gherkin"] }).exited;
    assert.equal(end.status, 1);
    assert.match(end.stderr, ACCOUNT_ERROR);
    assert.ok(issueOf(box.world()).labels.includes("start:gherkin"));
    assert.equal(issueOf(box.world()).comments.length, 0);
  } finally {
    box.cleanup();
  }
});

test("shutdown drains a live subprocess while an issue stop guards its publication", async () => {
  const box = machine();
  try {
    box.install("gherkin");
    const gate = box.gate();
    const run = box.launch("hippy", { tasks: ["gherkin"], gate });
    gate.ready();
    const ending = run.stop();
    box.change((world) => {
      apply(world, "agents:stop");
    });
    gate.release();
    const end = await ending;
    assert.equal(end.status, 0, end.stderr);
    assert.equal(run.exits().length, 1);
    assert.equal(marked(box.world(), "note").length, 0);
    assert.equal(marked(box.world(), "end").length, 1);
    assert.equal(
      issueOf(box.world()).labels.includes("agent:gherkin:running"),
      false,
    );
  } finally {
    box.cleanup();
  }
});

const BAD_INVOCATIONS = [
  {
    name: "a task mismatch",
    value: {
      version: 1,
      task: "land",
      issue: { repo: "acme/widgets", number: 7 },
      account: "hippy-dev",
      settings: {
        config: "/explicit/repo.json",
        base: "main",
        claimWaitsMs: [],
      },
    },
  },
  {
    name: "an unknown credential field",
    value: {
      version: 1,
      task: "gherkin",
      issue: { repo: "acme/widgets", number: 7 },
      account: "hippy-dev",
      token: "must-not-be-accepted",
      settings: {
        config: "/explicit/repo.json",
        base: "main",
        claimWaitsMs: [],
      },
    },
  },
  {
    name: "an unresolved settings path",
    value: {
      version: 1,
      task: "gherkin",
      issue: { repo: "acme/widgets", number: 7 },
      account: "hippy-dev",
      settings: { config: "relative.json", base: "main", claimWaitsMs: [] },
    },
  },
];
for (const { name, value } of BAD_INVOCATIONS) {
  test(`the task bootstrap rejects ${name} before claiming`, () => {
    const box = machine();
    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, "../../../../../dist/gherkin.mjs"),
          "--invocation",
        ],
        {
          input: JSON.stringify(value),
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 1);
      assert.equal(issueOf(box.world()).comments.length, 0);
      assert.ok(issueOf(box.world()).labels.includes("start:gherkin"));
    } finally {
      box.cleanup();
    }
  });
}
