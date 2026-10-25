// Opt-in, no-generation proof against a specifically supplied native package.
// Not in the default test glob. This never loads a real provider or task.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { snapshot } from "../job/git-review-test-kit.ts";
import { fixture, TIMEOUT_MS } from "./refactor-test-kit.ts";

const [, , nativeArgument]: string[] = process.argv;
const native = z.string().startsWith("/").parse(nativeArgument);
z.object({
  name: z.literal("@earendil-works/pi-coding-agent"),
  version: z.literal("1.2.0"),
}).parse(
  JSON.parse(fs.readFileSync(path.join(native, "package.json"), "utf8")),
);
const BUILD = fileURLToPath(new URL("../../build.ts", import.meta.url));
const DENY = `const fs = require("node:fs"); const cp = require("node:child_process");
const fail = () => { fs.appendFileSync(process.env.PROOF_DENIED,"external operation attempted\\n"); throw new Error("external operation denied"); };
globalThis.fetch=fail;require("node:net").Socket.prototype.connect=fail;require("node:tls").connect=fail;
const original=cp.spawnSync;cp.spawnSync=(command,args,options)=>{
 if(command===process.execPath && args[0]===process.env.PROOF_BIOME && (args[1]==="--version" || (["check","lint"].includes(args[1]) && args.includes("--reporter=json") && !args.includes("--write")))) return original(command,args,options);
 return fail();
};for(const name of ["spawn","exec","execSync","execFile","execFileSync","fork"])cp[name]=fail;`;
const VALIDATION: string = pathToFileURL(
  path.join(native, "..", "pi-ai", "dist", "utils", "validation.js"),
).href;
const PROBE = `import assert from "node:assert/strict"; import fs from "node:fs";
import { validateToolArguments } from ${JSON.stringify(VALIDATION)};
export default function(pi) {
 pi.registerProvider("refactor-proof", { baseUrl:"https://never.invalid/v1",apiKey:"not-a-secret",api:"openai-responses",
  streamSimple(){throw new Error("model generation is forbidden");},
  models:[{id:"offline",name:"Offline",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:32000}] });
 pi.on("session_start",()=>{
  assert.deepEqual(pi.getActiveTools().sort(),["safe_refactor","safe_refactor_finish"]);
  const names = pi.getAllTools().map(tool=>tool.name);
  for(const forbidden of ["edit","write","bash","read","codemode","pipeline_commit"]) assert.ok(!names.includes(forbidden),forbidden);
  const tool = pi.getAllTools().find(entry=>entry.name==="safe_refactor");
  const finish = pi.getAllTools().find(entry=>entry.name==="safe_refactor_finish");
  assert.ok(tool); assert.ok(finish);
  assert.equal(validateToolArguments(tool,{id:"inspect",name:tool.name,arguments:{operation:"inspect",file:"source.ts"}}).operation,"inspect");
  assert.equal(validateToolArguments(tool,{id:"check",name:tool.name,arguments:{operation:"check"}}).operation,"check");
  assert.throws(()=>validateToolArguments(tool,{id:"shell",name:tool.name,arguments:{operation:"shell",command:"never"}}));
  assert.throws(()=>validateToolArguments(tool,{id:"scope",name:tool.name,arguments:{operation:"inspect",file:"source.ts",root:"/tmp"}}));
  assert.equal(validateToolArguments(finish,{id:"finish",name:finish.name,arguments:{rationale:"A proposal only.",findings:[]}}).findings.length,0);
  fs.writeFileSync(process.env.PROOF_ACTIVE,JSON.stringify(pi.getActiveTools()));
 });
}`;

test("native restricted registry has no writer, shell or arbitrary-code tools without generation", () => {
  const project = fixture();
  const output = path.join(project.directory, "dist");
  const built = spawnSync(process.execPath, [BUILD, output], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  assert.equal(built.status, 0, built.stderr);
  const run = path.join(project.directory, "run");
  const agent = path.join(project.directory, "agent");
  const home = path.join(project.directory, "home");
  for (const directory of [run, agent, home]) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(
    path.join(run, "assignment.json"),
    JSON.stringify(project.assignment),
  );
  fs.writeFileSync(path.join(agent, "settings.json"), "{}");
  const guard = path.join(project.directory, "deny.cjs");
  const probe = path.join(project.directory, "probe.mjs");
  const active = path.join(project.directory, "active.json");
  const denied = path.join(project.directory, "denied.txt");
  fs.writeFileSync(guard, DENY);
  fs.writeFileSync(probe, PROBE);
  const before = snapshot(project.root);
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      guard,
      path.join(native, "dist/cli.js"),
      "--mode",
      "rpc",
      "--print",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "-nc",
      "-ns",
      "-np",
      "--no-themes",
      "--no-session",
      "--tools",
      "safe_refactor,safe_refactor_finish",
      "--model",
      "refactor-proof/offline",
      "-e",
      path.join(output, "safe-refactor-tool.mjs"),
      "-e",
      probe,
    ],
    {
      cwd: project.root,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      input: '{"id":"proof","type":"get_state"}\n',
      env: Object.fromEntries([
        ["HOME", home],
        ["PATH", "/nonexistent"],
        ["PI_CODING_AGENT_DIR", agent],
        ["PI_CODING_AGENT_SESSION_DIR", run],
        ["PI_OFFLINE", "1"],
        ["PI_SKIP_VERSION_CHECK", "1"],
        ["PI_TELEMETRY", "0"],
        ["SAFE_REFACTOR_RUN", run],
        ["PROOF_ACTIVE", active],
        ["PROOF_DENIED", denied],
        ["PROOF_BIOME", project.assignment.biome],
      ]),
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.ok(fs.existsSync(active), `${result.stderr}\n${result.stdout}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(active, "utf8")).sort(), [
    "safe_refactor",
    "safe_refactor_finish",
  ]);
  assert.equal(fs.existsSync(denied), false);
  assert.equal(snapshot(project.root), before);
  console.log(
    "Native restricted tool registry passed without model generation, network, shell or project writes.",
  );
});
