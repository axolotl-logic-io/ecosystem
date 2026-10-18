// @ts-check
// Account-only saved state served by fake gh, never a live API.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { commentLines, githubComment } from "./fake-gh.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

/** @import { Config } from "../src/config.ts" */
const bin = path.join(isolatedRoot, "authority-bin");
const states = path.join(isolatedRoot, "authority-states");
fs.mkdirSync(bin);
fs.mkdirSync(states);
const { PATH: searchPath = "" } = process.env;
Object.assign(
  process.env,
  Object.fromEntries([["PATH", `${bin}${path.delimiter}${searchPath}`]]),
);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") {
  const repo = args[args.indexOf("-R") + 1];
  const file = ${JSON.stringify(states)} + "/" + repo.replaceAll("/", "__") + ".pr.json";
  const reply = JSON.parse(fs.readFileSync(file, "utf8"));
  if (reply === null) { process.stderr.write("fake PR query failed"); process.exit(1); }
  process.stdout.write(JSON.stringify(reply)); process.exit(0);
}
const endpoint = args.find(arg => arg.startsWith("repos/"));
if (args[0] !== "api" || !endpoint?.endsWith("/comments?per_page=100")) {
  process.stderr.write("unexpected fake gh request"); process.exit(1);
}
const file = ${JSON.stringify(states)} + "/" + endpoint.split("/").slice(1, 3).join("__") + ".json";
process.stdout.write(fs.readFileSync(file, "utf8"));
if (fs.existsSync(file + ".next")) { fs.renameSync(file + ".next", file); }
`,
  { mode: 0o755 },
);

/** @param {Config} cfg @param {unknown} state @param {boolean} [afterRead] @returns {void} */
function saveAuthority(cfg, state, afterRead = false) {
  let text = "";
  if (state !== null) {
    text = commentLines([
      githubComment({
        id: 1,
        created: "2026-10-17T12:00:00Z",
        login: cfg.account,
        body: `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
      }),
    ]);
  }
  let file = path.join(states, `${cfg.repo.replaceAll("/", "__")}.json`);
  if (afterRead) {
    file += ".next";
  }
  fs.writeFileSync(file, text);
}

/** @param {Config} cfg @param {unknown} reply @returns {void} */
function savePrAuthority(cfg, reply) {
  fs.writeFileSync(
    path.join(states, `${cfg.repo.replaceAll("/", "__")}.pr.json`),
    JSON.stringify(reply),
  );
}

export { saveAuthority, savePrAuthority };
