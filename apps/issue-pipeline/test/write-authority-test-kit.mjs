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
const tokenIdentity = /^fake-pipeline-(dev|merge)--(.+)$/.exec(process.env.GH_TOKEN ?? "");
if (!tokenIdentity) throw new Error("missing fake credential");
if (args[0] === "api" && args[1] === "user") { process.stdout.write(tokenIdentity[2]); process.exit(0); }
let expectedIdentity = "merge";
if (args[0] === "pr" && ["create", "edit", "reopen", "close", "ready"].includes(args[1])) expectedIdentity = "dev";
if (tokenIdentity[1] !== expectedIdentity) throw new Error("wrong fake credential identity");

if (args[0] === "api" && args[1] === "graphql") {
  const id = args.find(arg => arg.startsWith("id="))?.slice(3);
  const stem = ${JSON.stringify(states)} + "/" + id.split(":")[0];
  const file = stem + ".json";
  const comments = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line));
  const comment = comments.find(item => item.node_id === id);
  if (!comment) throw new Error("unmatched provenance");
  const node = { databaseId: comment.id, body: comment.body, author: comment.user, createdAt: comment.created_at, updatedAt: comment.updated_at ?? comment.created_at, lastEditedAt: comment.lastEditedAt, editor: comment.editor };
  process.stdout.write(JSON.stringify({ data: { node } }));
  if (fs.existsSync(file + ".next")) fs.renameSync(file + ".next", file);
  process.exit(0);
}
const endpoint = args.find(arg => arg.startsWith("repos/"));
let repo = endpoint?.split("/").slice(1, 3).join("/");
if (args.includes("-R")) repo = args[args.indexOf("-R") + 1];
const stem = ${JSON.stringify(states)} + "/" + repo.replaceAll("/", "__");
fs.appendFileSync(stem + ".calls", JSON.stringify(args) + "\\n");
if (args[0] === "api" && !args.includes("-X") && endpoint === "repos/" + repo + "/issues/7" && fs.existsSync(stem + ".issue.json")) {
  process.stdout.write(fs.readFileSync(stem + ".issue.json", "utf8")); process.exit(0);
}
if (args[0] === "api" && endpoint === "repos/" + repo + "/collaborators/alice" && fs.existsSync(stem + ".issue.json")) {
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list" && args.includes("all")) {
  process.stdout.write(fs.readFileSync(stem + ".history.json", "utf8")); process.exit(0);
}
const method = args[args.indexOf("-X") + 1];
const postComment = method === "POST" && ["7", "42"].some(n => endpoint === "repos/" + repo + "/issues/" + n + "/comments");
const patchState = method === "PATCH" && endpoint === "repos/" + repo + "/issues/comments/1";
const postLabel = method === "POST" && ["7", "42"].some(n => endpoint === "repos/" + repo + "/issues/" + n + "/labels") && args.some(arg => ["labels[]=agent:stopped-not-doable", "labels[]=agent:stopped-error"].includes(arg));
const removeWorking = method === "DELETE" && ["7", "42"].some(n => endpoint === "repos/" + repo + "/issues/" + n + "/labels/agent%3Aworking");
if (args[0] === "api" && args.includes("-X") && (postComment || patchState || postLabel || removeWorking)) {
  const field = args.find(arg => arg.startsWith("body="));
  if (patchState && (field?.startsWith("body=<!-- agent-pipeline:state") || field?.startsWith("body=**🤖 issue-pipeline · state**"))) {
    const body = field.slice(5);
    fs.writeFileSync(stem + ".json", JSON.stringify({ id: 1, node_id: repo.replaceAll("/", "__") + ":1", lastEditedAt: null, editor: null, user: { login: "bot" }, created_at: "2026-10-18T00:00:00Z", body }));
  }
  process.stdout.write("99"); process.exit(0);
}
if (args[0] === "api" && !args.includes("-X") && ["7", "42"].some(n => endpoint === "repos/" + repo + "/issues/" + n + "/labels")) {
  process.stdout.write("[]"); process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  const repo = args[args.indexOf("-R") + 1];
  const file = ${JSON.stringify(states)} + "/" + repo.replaceAll("/", "__") + ".pr.json";
  const reply = JSON.parse(fs.readFileSync(file, "utf8"));
  if (reply === null) { process.stderr.write("fake PR query failed"); process.exit(1); }
  process.stdout.write(JSON.stringify(reply)); process.exit(0);
}
if (args[0] !== "api" || args.includes("-X") || !endpoint?.endsWith("/comments?per_page=100")) {
  process.stderr.write("unexpected fake gh request"); process.exit(1);
}
const file = ${JSON.stringify(states)} + "/" + endpoint.split("/").slice(1, 3).join("__") + ".json";
process.stdout.write(fs.readFileSync(file, "utf8"));

`,
  { mode: 0o755 },
);

/** @param {Config} cfg @param {unknown} state @param {boolean} [afterRead] @returns {void} */
function saveAuthority(cfg, state, afterRead = false) {
  const history = path.join(
    states,
    `${cfg.repo.replaceAll("/", "__")}.history.json`,
  );
  if (!fs.existsSync(history)) {
    fs.writeFileSync(history, "[]");
  }
  let text = "";
  if (state !== null) {
    text = commentLines([
      {
        ...githubComment({
          id: 1,
          nodeId: `${cfg.repo.replaceAll("/", "__")}:1`,
          created: "2026-10-17T12:00:00Z",
          login: cfg.mergeAccount,
          body: `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
        }),
      },
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

/** @param {Config} cfg @param {unknown} rows @returns {void} */
function savePrHistory(cfg, rows) {
  fs.writeFileSync(
    path.join(states, `${cfg.repo.replaceAll("/", "__")}.history.json`),
    JSON.stringify(rows),
  );
}

/** @param {Config} cfg @returns {string[][]} */
function authorityCalls(cfg) {
  return fs
    .readFileSync(
      path.join(states, `${cfg.repo.replaceAll("/", "__")}.calls`),
      "utf8",
    )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** @param {Config} cfg @param {string[]} bodies @returns {void} */
function saveAuthorityBodies(cfg, bodies) {
  const comments = bodies.map((body, at) => ({
    ...githubComment({
      id: at + 1,
      nodeId: `${cfg.repo.replaceAll("/", "__")}:${at + 1}`,
      login: cfg.mergeAccount,
      created: "2026-10-18T00:00:00Z",
      body,
    }),
  }));
  fs.writeFileSync(
    path.join(states, `${cfg.repo.replaceAll("/", "__")}.json`),
    commentLines(comments),
  );
}

/** @param {Config} cfg @param {object} issue @returns {void} */
function saveIssueAuthority(cfg, issue) {
  fs.writeFileSync(
    path.join(states, `${cfg.repo.replaceAll("/", "__")}.issue.json`),
    JSON.stringify(issue),
  );
}

export {
  authorityCalls,
  saveAuthority,
  saveAuthorityBodies,
  saveIssueAuthority,
  savePrAuthority,
  savePrHistory,
};
