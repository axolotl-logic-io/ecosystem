// The spec writer, the code writers and the first reviewers read the configured
// coding practices in full (config `practices`), and the config refuses entries
// outside the worktree. Both files
// run on load, so the functions are lifted from their source.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const grab = (src, name) => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`))[0];
const workflow = read("src/workflow.js");
const ops = read("src/ops.mjs");

const practicesUse = workflow.match(/const PRACTICES_USE = \{[\s\S]*?\n\};\n/)[0];
const practicesNote = (cfg) => new Function("cfg", `${practicesUse}${grab(workflow, "practicesNote")}return practicesNote;`)(cfg);
const item = { paths: { worktree: "/w/issue-7" } };

test("the spec task names every practices file under the worktree", () => {
  const note = practicesNote({ practices: ["CONTRIBUTING.md", "wiki/Decisions.md"] })(item);
  assert.match(note, /read each of these in full/);
  assert.match(note, /\/w\/issue-7\/CONTRIBUTING\.md, \/w\/issue-7\/wiki\/Decisions\.md\./);
  assert.match(note, /all of the repo's code/);
  assert.match(note, /needs-info/);
});

test("the spec task says when no practices are configured", () => {
  assert.match(practicesNote({ practices: [] })(item), /\(none configured\)/);
});

test("each role is told what to do with them", () => {
  const note = practicesNote({ practices: ["CONTRIBUTING.md"] });
  assert.match(note(item, "spec"), /The spec must follow them/);
  assert.match(note(item, "writer"), /Every change you make must follow them/);
  assert.match(note(item, "reviewer"), /mark it `blocking`, quote the rule/);
});

const taskOf = (label) => {
  const at = workflow.indexOf(`label: "${label}`);
  assert.ok(at > 0, label);
  return workflow.slice(at, workflow.indexOf(".join(", at));
};

test("the spec, implement, fix and first-review tasks carry the note", () => {
  assert.match(taskOf("Write the spec"), /practicesNote\(it, "spec"\)/);
  assert.match(taskOf("Implement issue"), /practicesNote\(it, "writer"\)/);
  assert.match(taskOf("Fix review findings"), /practicesNote\(it, "writer"\)/);
  assert.match(taskOf("Fix failing checks"), /practicesNote\(it, "writer"\)/);
  assert.match(taskOf("Review "), /practicesNote\(it, "reviewer"\)/);
});

const defaults = new Function(`${ops.match(/const DEFAULTS = \{[\s\S]*?\n\};\n/)[0]}return DEFAULTS;`)();
class OpsError extends Error {}
const loadConfig = new Function("fs", "path", "OpsError", "expand", "DEFAULTS", `${grab(ops, "loadConfig")}return loadConfig;`)(
  fs,
  path,
  OpsError,
  (p) => p,
  defaults,
);
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
