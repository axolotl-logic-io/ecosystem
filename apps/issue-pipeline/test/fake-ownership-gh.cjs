// @ts-check
// The coordination half of a fake gh (fake-ownership.mjs, #169): it answers
// the calls the real transport makes from what that transport wrote to the
// store `ownership.json` in `dir`, and exits. For a comment listing it
// answers nothing itself and returns the issue's records, which the fake
// appends to its own scripted comments, and `done`, which the fake calls
// once it has answered. With no store, it does nothing.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { spawnSync } = require("node:child_process");

const SHA_LENGTH = 40;
const HEX = 16;
const COORDINATION_REF = "git/ref/heads/pipeline-coordination/";
const POSTED = /^issues\/(?<issue>\d+)\/comments$/u;
const LISTED = /^issues\/(?<issue>\d+)\/comments\?per_page=100$/u;
const QUIET = "1";

/** @param {readonly string[]} args @returns {string[]} */
function batchIds(args) {
  const ids = [];
  for (let at = 0; args.some((arg) => arg.startsWith(`c${at}=`)); at += 1) {
    const entry = args.find((arg) => arg.startsWith(`c${at}=`)) ?? "";
    ids.push(entry.slice(entry.indexOf("=") + 1));
  }
  return ids;
}

/** @param {string} text @returns {never} */
function send(text) {
  fs.writeSync(1, text);
  process.exit(0);
}

/** @param {string} text @returns {never} */
function fail(text) {
  fs.writeSync(2, text);
  process.exit(1);
}

/** @returns {any} */
function input() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

/** @param {readonly string[]} args @param {string} name @returns {string} */
function field(args, name) {
  const found = args.find((arg) => arg.startsWith(`${name}=`)) ?? "";
  return found.slice(name.length + 1);
}

/** @param {any} item @returns {object} */
function nodeOf(item) {
  return {
    databaseId: item.id,
    body: item.body,
    author: item.user,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    lastEditedAt: null,
    editor: null,
  };
}

/** @param {any} own @param {string} route @returns {void} */
function serveRefs(own, route) {
  const coordination = route.startsWith(COORDINATION_REF);
  if (
    coordination ||
    (own.acquiring && route === `git/ref/heads/${own.base}`)
  ) {
    const sha = own.refs[route.slice("git/ref/".length)];
    if (sha === undefined) {
      fail("HTTP 404: Not Found");
    }
    send(JSON.stringify({ object: { sha } }));
  }
  if (route.startsWith("git/commits/")) {
    const commit = own.commits[route.slice("git/commits/".length)];
    if (commit !== undefined) {
      send(JSON.stringify(commit));
    }
  }
}

/** @param {any} own @param {readonly string[]} args @param {string} route @param {() => void} save @returns {void} */
function serveRefWrites(own, args, route, save) {
  if (!args.includes("POST")) {
    return;
  }
  if (route === "git/commits") {
    own.token += 1;
    const sha = own.token.toString(HEX).padStart(SHA_LENGTH, "0");
    own.commits[sha] = { sha, tree: { sha: input().tree } };
    save();
    send(JSON.stringify(own.commits[sha]));
  }
  if (route === "git/refs") {
    const body = input();
    const name = body.ref.slice("refs/".length);
    if (own.refs[name] !== undefined) {
      fail("HTTP 422: Reference already exists");
    }
    own.refs[name] = body.sha;
    save();
    send(JSON.stringify({ object: { sha: body.sha } }));
  }
}

/** @param {any} own @param {{ args: readonly string[], route: string, login: string, save: () => void }} call @returns {void} */
function serveRecords(own, { args, route, login, save }) {
  const body = field(args, "body");
  const posted = POSTED.exec(route)?.groups?.issue;
  if (
    posted !== undefined &&
    args.includes("POST") &&
    body.includes("agent-pipeline:coordination")
  ) {
    own.seq += 1;
    own.comments.push(
      Object.fromEntries([
        ["id", own.seq],
        ["node_id", `coordination-${own.seq}`],
        ["issue", Number(posted)],
        ["user", { login }],
        ["created_at", "2026-10-18T00:00:00Z"],
        ["updated_at", "2026-10-18T00:00:00Z"],
        ["lastEditedAt", null],
        ["editor", null],
        ["body", body],
      ]),
    );
    save();
    send("");
  }
  if (args[0] !== "api" || args[1] !== "graphql") {
    return;
  }
  const batch = batchIds(args);
  let ids = batch;
  if (ids.length === 0) {
    ids = [field(args, "id")];
  }
  const items = ids.map((id) =>
    own.comments.find((/** @type {any} */ item) => item.node_id === id),
  );
  if (items.some((item) => item === undefined)) {
    return;
  }
  if (batch.length > 0) {
    send(
      JSON.stringify({
        data: Object.fromEntries(
          items.map((item, at) => [`c${at}`, nodeOf(item)]),
        ),
      }),
    );
  }
  send(JSON.stringify({ data: { node: nodeOf(items.at(0)) } }));
}

/**
 * @param {string} dir
 * @param {readonly string[]} args
 * @param {string} login
 * @returns {{ records: object[], done: () => void } | null}
 */
function serveOwnership(dir, args, login) {
  const file = path.join(dir, "ownership.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  const own = JSON.parse(fs.readFileSync(file, "utf8"));
  function save() {
    fs.writeFileSync(file, JSON.stringify(own));
  }
  // A successor takes the issue once this read is answered (takeover()).
  function done() {
    const { env } = process;
    const { FAKE_OWNERSHIP_QUIET: quiet } = env;
    if (own.takeover !== true || quiet === QUIET) {
      return;
    }
    own.takeover = false;
    save();
    const taken = spawnSync(process.execPath, [own.owner, "successor"], {
      input: JSON.stringify(own.request),
      encoding: "utf8",
      env: Object.fromEntries([
        ...Object.entries(env),
        ["FAKE_OWNERSHIP_QUIET", QUIET],
      ]),
    });
    if (taken.status !== 0) {
      throw new Error(`the successor didn't take the issue: ${taken.stderr}`);
    }
  }
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const prefix = `repos/${own.repo}/`;
  if (!endpoint.startsWith(prefix)) {
    serveRecords(own, { args, route: "", login, save });
    return null;
  }
  const route = endpoint.slice(prefix.length);
  serveRefs(own, route);
  serveRefWrites(own, args, route, save);
  serveRecords(own, { args, route, login, save });
  const listed = LISTED.exec(route)?.groups?.issue;
  if (listed === undefined) {
    return null;
  }
  const records = own.comments.filter(
    (/** @type {any} */ item) => item.issue === Number(listed),
  );
  return { records, done };
}

module.exports = { serveOwnership };
