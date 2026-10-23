// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_FIXTURES = fileURLToPath(
  new URL("../runtime-fixtures.mjs", import.meta.url),
);
const FAKE_PI = `#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { fixtureState, versionProbe } from ${JSON.stringify(RUNTIME_FIXTURES)};
const args = process.argv.slice(2);
if (versionProbe(args)) process.exit(0);
const at = (name) => args[args.indexOf(name) + 1];
assert.equal(at("--tools"), "safe_refactor,safe_refactor_finish");
for (const flag of ["--no-extensions", "-nc", "-ns", "-np", "--offline"]) assert.ok(args.includes(flag));
const directory = process.env.SAFE_REFACTOR_RUN;
const assignment = JSON.parse(fs.readFileSync(path.join(directory, "assignment.json"), "utf8"));
const baseline = JSON.parse(fs.readFileSync(path.join(directory, "baseline.json"), "utf8"));
const tools = new Map();
const listeners = new Map();
let active = [];
const extension = args.find((arg) => arg.endsWith("safe-refactor-tool.mjs"));
const { default: register } = await import(pathToFileURL(extension));
register({ registerTool: (tool) => tools.set(tool.name, tool), setActiveTools: (names) => { active = names; }, on: (name, handler) => listeners.set(name, handler) });
const send = (record) => console.log(JSON.stringify(record));
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, command: "get_state", success: true, data: fixtureState(at("--model")) });
  } else if (command.type === "prompt") {
    listeners.get("session_start")();
    assert.deepEqual(active, ["safe_refactor", "safe_refactor_finish"]);
    for (const name of ["edit", "write", "bash", "codemode", "pipeline_commit", "shell", "subagent", "read"]) {
      assert.equal(tools.has(name), false);
      assert.equal(listeners.get("tool_call")({ toolName: name }).block, true);
    }
    assert.equal(listeners.get("tool_call")({ toolName: "safe_refactor" }).block, false);
    const tool = tools.get("safe_refactor");
    for (const request of [
      { operation: "shell", command: "touch escaped" },
      { operation: "jscodeshift", transform: "arbitrary source" },
      { operation: "read", file: "../request.json" },
      { operation: "read", file: ".env.local" },
      { operation: "read", file: "GLOSSARY.md", root: "/tmp" },
    ]) await assert.rejects(async () => tool.execute("forbidden", request));
    const glossary = await tool.execute("glossary", { operation: "read", file: "GLOSSARY.md" });
    assert.ok(glossary.details.text.includes("Amount"));
    const inspection = (await tool.execute("inspect", { operation: "inspect", file: assignment.files[0] })).details;
    const firstPage = (await tool.execute("baseline", { operation: "check", baseline: true, limit: 80 })).details;
    assert.equal(firstPage.text.length, 80);
    let baselineText = "";
    for (let offset = 0; offset < firstPage.totalCharacters; offset += 20000) {
      const page = (await tool.execute("baseline-page", { operation: "check", baseline: true, offset, limit: 20000 })).details;
      assert.equal(page.hash, firstPage.hash);
      baselineText += page.text;
    }
    assert.deepEqual(JSON.parse(baselineText), baseline);
    const operation = { operation: "rename-symbol", target: { file: assignment.files[0], symbol: "total.amount" }, source: inspection.source, name: "subtotal", rationale: "Use the domain name for the unadjusted amount." };
    await tool.execute("rename", operation);
    const original = (await tool.execute("original-baseline", { operation: "check", baseline: true, limit: 80 })).details;
    const current = (await tool.execute("current-check", { operation: "check", limit: 80 })).details;
    assert.equal(original.hash, firstPage.hash);
    assert.notEqual(current.hash, firstPage.hash);
    await assert.rejects(async () => tool.execute("stale", operation));
    const finish = tools.get("safe_refactor_finish");
    await assert.rejects(async () => finish.execute("incomplete", { rationale: "Not enough evidence", findings: [] }));
    const findings = baseline.checks.find((entry) => entry.name === "metrics").diagnostics.map((entry) => ({ id: entry.id, disposition: "deferred", reason: "Naming improved; further design changes are outside this bounded operation." }));
    await finish.execute("report", { rationale: "Clarified the subtotal name without changing observable output or reducing checks.", findings });
    await assert.rejects(async () => tool.execute("after-finish", operation));
    listeners.get("session_shutdown")();
    send({ type: "agent_settled" });
  }
}
`;

/** @param {string} directory @returns {string} */
function fakePi(directory) {
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pi"), FAKE_PI, { mode: 0o755 });
  return bin;
}

export { fakePi };
