// The task app framework's claim confirmation, its run records and the
// earlier comments a run continues from, through the sample task app and
// fake GitHub.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { TASK_RUN } from "../../../src/task-app/run-record.ts";
import {
  apply,
  BUDDIES,
  issueOf,
  machine,
  marked,
  REPO,
} from "../../support/task-app/task-app-test-kit.ts";

const START = "start:sample";
const RUNNING = "agent:sample:running";
// Reads of the issue's events before a claim is confirmed: one before the
// removal, then one per confirmation attempt; the kit's buddies wait three
// times.
const READS_BEFORE_REMOVAL = 1;
const CONFIRMATIONS = 4;
const UNCONFIRMED = /couldn't confirm the claim/u;

function records(pipeline: string): unknown[] {
  const folder = path.join(
    pipeline,
    "runs",
    REPO.replace("/", "__"),
    "issue-7",
    "task-runs",
  );
  if (!fs.existsSync(folder)) {
    return [];
  }
  return fs
    .readdirSync(folder)
    .map((id): unknown =>
      JSON.parse(fs.readFileSync(path.join(folder, id, "run.json"), "utf8")),
    );
}

test("a claim waits for a timeline that lags behind the removal", async () => {
  const box = machine((world) => {
    world.timelineLag = READS_BEFORE_REMOVAL + 2;
  });
  try {
    assert.equal((await box.runToEnd("hippy")).status, 0);
    assert.equal(marked(box.world(), "note").length, 1);
    assert.deepEqual(issueOf(box.world()).labels, []);
  } finally {
    box.cleanup();
  }
});

test("a claim the timeline never confirms posts that and holds no running label", async () => {
  const box = machine((world) => {
    world.timelineLag = READS_BEFORE_REMOVAL + CONFIRMATIONS;
  });
  try {
    assert.equal((await box.runToEnd("hippy")).status, 1);
    const [end] = marked(box.world(), "end");
    assert.match(end?.body ?? "", UNCONFIRMED);
    assert.deepEqual(marked(box.world(), "note"), []);
    assert.deepEqual(records(box.pipeline), []);
    box.change((world) => apply(world, START));
    assert.equal((await box.runToEnd("lawd")).status, 0);
    assert.deepEqual(issueOf(box.world()).labels, []);
  } finally {
    box.cleanup();
  }
});

test("only the run that wins the claim writes a run record", async () => {
  const box = machine();
  try {
    await Promise.all([box.runToEnd("hippy"), box.runToEnd("lawd")]);
    const [record, ...others] = records(box.pipeline).map((raw) =>
      TASK_RUN.parse(raw),
    );
    assert.deepEqual(others, []);
    const removal = issueOf(box.world()).events.find(
      (event) => event.event === "unlabeled" && event.label === START,
    );
    assert.equal(record?.account, removal?.actor);
    assert.deepEqual(record?.claim, { start: 100, removal: removal?.id });
    assert.equal(record?.state, "ended");
    assert.equal(record?.outcome, "succeeded");
  } finally {
    box.cleanup();
  }
});

test("a run continues from the notes earlier runs left, not from forged ones", async () => {
  const box = machine((world) => {
    world.accounts.push({ login: "mallory", id: 11, type: "User" });
    issueOf(world).comments.push({
      id: 400,
      author: "mallory",
      body: 'Sample note 41.\n\n<!-- task-app:sample:note {"run":"x"} -->',
      editor: null,
      createdAt: "2026-10-25T11:30:00Z",
    });
  });
  try {
    assert.equal((await box.runToEnd("hippy")).status, 0);
    box.change((world) => apply(world, START));
    assert.equal((await box.runToEnd("lawd")).status, 0);
    const notes = marked(box.world(), "note")
      .filter((note) => note.author !== "mallory")
      .map((note) => [note.author, note.body.split("\n")[0]]);
    assert.deepEqual(notes, [
      [BUDDIES.hippy, "Sample note 1."],
      [BUDDIES.lawd, "Sample note 2."],
    ]);
    assert.equal(issueOf(box.world()).labels.includes(RUNNING), false);
  } finally {
    box.cleanup();
  }
});
