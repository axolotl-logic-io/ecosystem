// @ts-check
// The coordination half of a fake gh (fake-ownership.mjs, #169): it answers
// the calls the real transport makes from what that transport wrote to the
// store `ownership.json` in `dir`, and exits. For a comment listing it
// answers nothing itself and returns the issue's records, which the fake
// appends to its own scripted comments, and `done`, which the fake calls
// once it has answered. With no store, it does nothing.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/** @param {readonly string[]} args @returns {string[] | null} */
function batchIds(args) {
  const ids = [];
  for (let at = 0; args.some((arg) => arg.startsWith(`c${at}=`)); at += 1) {
    const field = args.find((arg) => arg.startsWith(`c${at}=`)) ?? "";
    ids.push(field.slice(field.indexOf("=") + 1));
  }
  return ids.length === 0 ? null : ids;
}

/** @param {string} text @returns {never} */
function send(text) {
  fs.writeSync(1, text);
  process.exit(0);
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
  const save = () => fs.writeFileSync(file, JSON.stringify(own));
  const quiet = process.env["FAKE_OWNERSHIP_QUIET"] === "1";
  // A successor takes the issue once this read is answered (takeover()).
  const done = () => {
    if (own.takeover !== true || quiet) {
      return;
    }
    own.takeover = false;
    save();
    const taken = spawnSync(process.execPath, [own.owner, "successor"], {
      input: JSON.stringify(own.request),
      encoding: "utf8",
      env: { ...process.env, FAKE_OWNERSHIP_QUIET: "1" },
    });
    if (taken.status !== 0) {
      throw new Error(`the successor didn't take the issue: ${taken.stderr}`);
    }
  };
  const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
  const prefix = `repos/${own.repo}/`;
  const route = endpoint.startsWith(prefix)
    ? endpoint.slice(prefix.length)
    : "";
  const input = () => JSON.parse(fs.readFileSync(0, "utf8"));
  const coordinationRef = route.startsWith("git/ref/heads/pipeline-coordination/");
  if (coordinationRef || (own.acquiring && route === `git/ref/heads/${own.base}`)) {
    const sha = own.refs[route.slice("git/ref/".length)];
    if (!sha) {
      fs.writeSync(2, "HTTP 404: Not Found");
      process.exit(1);
    }
    send(JSON.stringify({ object: { sha } }));
  }
  if (route === "git/commits" && args.includes("POST")) {
    own.token += 1;
    const sha = own.token.toString(16).padStart(40, "0");
    own.commits[sha] = { sha, tree: { sha: input().tree } };
    save();
    send(JSON.stringify(own.commits[sha]));
  }
  const commit = route.startsWith("git/commits/")
    ? own.commits[route.slice("git/commits/".length)]
    : undefined;
  if (commit) {
    send(JSON.stringify(commit));
  }
  if (route === "git/refs" && args.includes("POST")) {
    const body = input();
    const name = body.ref.slice("refs/".length);
    if (own.refs[name]) {
      fs.writeSync(2, "HTTP 422: Reference already exists");
      process.exit(1);
    }
    own.refs[name] = body.sha;
    save();
    send(JSON.stringify({ object: { sha: body.sha } }));
  }
  const body =
    args.find((arg) => arg.startsWith("body="))?.slice("body=".length) ?? "";
  const posted = /^issues\/(\d+)\/comments$/u.exec(route);
  if (posted && args.includes("POST") && body.includes("agent-pipeline:coordination")) {
    own.seq += 1;
    own.comments.push({
      id: own.seq,
      node_id: `coordination-${own.seq}`,
      issue: Number(posted[1]),
      user: { login },
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
      lastEditedAt: null,
      editor: null,
      body,
    });
    save();
    send("");
  }
  if (args[0] === "api" && args[1] === "graphql") {
    const ids = batchIds(args) ?? [
      args.find((arg) => arg.startsWith("id="))?.slice(3),
    ];
    const nodeOf = (/** @type {string | undefined} */ id) => {
      const item = own.comments.find(
        (/** @type {any} */ comment) => comment.node_id === id,
      );
      if (!item) {
        return null;
      }
      return {
        databaseId: item.id,
        body: item.body,
        author: item.user,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        lastEditedAt: null,
        editor: null,
      };
    };
    if (ids.every((id) => nodeOf(id) !== null)) {
      if (batchIds(args)) {
        send(JSON.stringify({ data: Object.fromEntries(ids.map((id, at) => [`c${at}`, nodeOf(id)])) }));
      }
      send(JSON.stringify({ data: { node: nodeOf(ids[0]) } }));
    }
  }
  const listed = /^issues\/(\d+)\/comments\?per_page=100$/u.exec(route);
  if (listed) {
    const records = own.comments.filter(
      (/** @type {any} */ item) => item.issue === Number(listed[1]),
    );
    return { records, done };
  }
  return null;
}

module.exports = { serveOwnership };
