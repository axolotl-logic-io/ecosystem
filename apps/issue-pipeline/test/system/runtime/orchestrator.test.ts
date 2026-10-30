// The installed orchestrator runs real standalone launchers against fake GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  apply,
  machine,
  marked,
} from "../../support/task-app/task-app-test-kit.ts";

const BUDDIES = [
  { buddy: "hippy", tasks: ["gherkin"] },
  { buddy: "lawd", tasks: ["fix"] },
] as const;

test("two supervised launchers execute their own tasks and drain on orchestrator shutdown", async () => {
  const box = machine((world) => apply(world, "start:fix"));
  try {
    box.install("gherkin");
    box.install("fix");
    const gates = ["gherkin", "fix"].map((task) => {
      const gate = box.gate();
      const worker = path.join(box.pipeline, `${task}.mjs`);
      fs.writeFileSync(
        worker,
        `process.env.SAMPLE_TASK_GATE = ${JSON.stringify(gate.path)};\n${fs.readFileSync(worker, "utf8")}`,
      );
      return gate;
    });
    const run = box.orchestrate(
      BUDDIES.map(({ buddy, tasks }) => ({ buddy, tasks: [...tasks] })),
    );
    for (const gate of gates) {
      gate.ready();
    }
    const ending = run.stop();
    box.change((world) => apply(world, "agents:stop"));
    for (const gate of gates) {
      gate.release();
    }
    const end = await ending;
    assert.equal(end.status, 0, end.stderr);
    assert.deepEqual(JSON.parse(end.stdout), { kind: "stopped", failed: [] });
    assert.deepEqual(
      run
        .exits()
        .map(({ task }) => task)
        .sort((a, b) => a.localeCompare(b)),
      ["fix", "gherkin"],
    );
    for (const task of ["gherkin", "fix"]) {
      assert.equal(marked(box.world(), "note", task).length, 0);
      assert.equal(marked(box.world(), "end", task).length, 1);
    }
  } finally {
    box.cleanup();
  }
});

test("one refused launcher leaves its healthy sibling operating and reports a failed fleet", async () => {
  const box = machine((world) => {
    world.tokens = world.tokens.filter(({ login }) => login !== "lawd-landing");
  });
  try {
    box.install("gherkin");
    box.install("fix");
    const run = box.orchestrate(
      BUDDIES.map(({ buddy, tasks }) => ({ buddy, tasks: [...tasks] })),
    );
    const task = await run.exit((exit) => exit.task === "gherkin");
    assert.equal(task.exit, 0);
    const end = await run.stop();
    assert.equal(end.status, 1, end.stderr);
    assert.deepEqual(JSON.parse(end.stdout), {
      kind: "stopped",
      failed: ["lawd"],
    });
    assert.equal(marked(box.world(), "note").length, 1);
  } finally {
    box.cleanup();
  }
});
