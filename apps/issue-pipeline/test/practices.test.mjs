// The spec writer, the code writers and the first reviewers read the configured
// coding practices in full (config `practices`), and the config refuses entries
// outside the worktree.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { OpsError } from "../src/process.ts";
import { practicesNote } from "../src/workflow/prompts.ts";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const workflow = read("src/workflow.js");
const item = { paths: { worktree: "/w/issue-7" } };

test("the spec task names every practices file under the worktree", () => {
  const note = practicesNote({ practices: ["CONTRIBUTING.md", "wiki/Decisions.md"] }, item);
  assert.match(note, /read each of these in full/);
  assert.match(note, /\/w\/issue-7\/CONTRIBUTING\.md, \/w\/issue-7\/wiki\/Decisions\.md\./);
  assert.match(note, /all of the repo's code/);
  assert.match(note, /needs-info/);
});

test("the spec task says when no practices are configured", () => {
  assert.match(practicesNote({ practices: [] }, item), /\(none configured\)/);
});

test("each role is told what to do with them", () => {
  const cfg = { practices: ["CONTRIBUTING.md"] };
  assert.match(practicesNote(cfg, item, "spec"), /The spec must follow them/);
  assert.match(practicesNote(cfg, item, "writer"), /Every change you make must follow them/);
  assert.match(practicesNote(cfg, item, "reviewer"), /mark it `blocking`, quote the rule/);
});

const taskOf = (label) => {
  const at = workflow.indexOf(`label: "${label}`);
  assert.ok(at > 0, label);
  return workflow.slice(at, workflow.indexOf(".join(", at));
};

test("the spec, implement, fix and first-review tasks carry the note", () => {
  assert.match(taskOf("Write the spec"), /practicesNote\(cfg, it, "spec"\)/);
  assert.match(taskOf("Implement issue"), /practicesNote\(cfg, it, "writer"\)/);
  assert.match(taskOf("Fix review findings"), /practicesNote\(cfg, it, "writer"\)/);
  assert.match(taskOf("Fix failing checks"), /practicesNote\(cfg, it, "writer"\)/);
  assert.match(taskOf("Review "), /practicesNote\(cfg, it, "reviewer"\)/);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-practices-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const configWith = (extra) => {
  const file = path.join(tmp, `${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({ repo: "o/r", account: "a", allowedUsers: ["a"], commands: { test: "true" }, ...extra }));
  return file;
};

test("practices default to AGENTS.md and CONTRIBUTING.md", () => {
  assert.deepEqual(loadConfig(configWith({})).practices, ["AGENTS.md", "CONTRIBUTING.md"]);
});

test("practices entries must stay inside the worktree", () => {
  for (const bad of ["/etc/passwd", "../x.md", "wiki/../../x.md", "", 3]) {
    assert.throws(() => loadConfig(configWith({ practices: [bad] })), OpsError, JSON.stringify(bad));
  }
  assert.throws(() => loadConfig(configWith({ practices: "CONTRIBUTING.md" })), OpsError);
});
