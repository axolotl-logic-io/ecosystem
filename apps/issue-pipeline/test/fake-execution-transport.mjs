// @ts-check
import fs from "node:fs";
import path from "node:path";

// Private authenticated HTTP surface. It stores what the real adapter writes;
// it never synthesizes requests, owner confirmations, receipts or releases.
const EXECUTION_TRANSPORT = `
const transportFile = path.join(dir, "execution-transport.json");
if (fs.existsSync(transportFile)) {
  const transport = JSON.parse(fs.readFileSync(transportFile, "utf8"));
  const endpoint = args.find(arg => arg.startsWith("repos/")) ?? "";
  const save = () => fs.writeFileSync(transportFile, JSON.stringify(transport));
  const log = () => {
    fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
    fs.appendFileSync(path.join(dir, "identities.jsonl"), JSON.stringify({ identity: identity[1], args }) + "\\n");
  };
  const send = value => { log(); fs.writeSync(1, value); process.exit(0); };
  const json = value => send(JSON.stringify(value));
  const fail = message => { log(); fs.writeSync(2, message); process.exit(1); };
  const payload = () => {
    if (args.includes("--input")) return JSON.parse(fs.readFileSync(0, "utf8"));
    return Object.fromEntries(args.filter(arg => arg.includes("=")).map(arg => {
      const at = arg.indexOf("="); return [arg.slice(0, at), arg.slice(at + 1)];
    }));
  };
  const prefix = "repos/" + transport.repo + "/";
  const ref = endpoint.slice((prefix + "git/ref/").length);
  if (endpoint.startsWith(prefix + "git/ref/")) {
    if (!transport.refs[ref]) fail("HTTP 404");
    json({ object: { sha: transport.refs[ref] } });
  }
  if (endpoint === prefix + "git/commits" && args.includes("POST")) {
    const body = payload();
    transport.token += 1;
    const sha = transport.token.toString(16).padStart(40, "0");
    transport.commits[sha] = { sha, tree: { sha: body.tree } };
    save(); json(transport.commits[sha]);
  }
  if (endpoint.startsWith(prefix + "git/commits/")) {
    json(transport.commits[endpoint.slice((prefix + "git/commits/").length)]);
  }
  if (endpoint === prefix + "git/refs" && args.includes("POST")) {
    const body = payload(); const name = body.ref.slice(5);
    if (transport.refs[name]) fail("HTTP 422 already exists");
    transport.refs[name] = body.sha; save(); json({ object: { sha: body.sha } });
  }
  const listing = /^issues\\/(\\d+)\\/comments\\?per_page=100$/.exec(endpoint.slice(prefix.length));
  if (listing) {
    send(transport.comments.filter(item => item.issue === Number(listing[1])).map(item => JSON.stringify(item) + "\\n").join(""));
  }
  if (args[0] === "api" && args[1] === "graphql") {
    const nodeOf = id => {
      const comment = transport.comments.find(item => item.node_id === id);
      if (!comment) return null;
      return { databaseId: comment.id, body: comment.graphBody ?? comment.body, author: comment.graphAuthor ?? comment.user, createdAt: comment.created_at, updatedAt: comment.updated_at, lastEditedAt: comment.lastEditedAt, editor: comment.editor };
    };
    const batch = batchIds(args);
    if (batch) send(batchAnswer(batch, nodeOf));
    const id = args.find(arg => arg.startsWith("id="))?.slice(3);
    if (nodeOf(id)) json({ data: { node: nodeOf(id) } });
  }
  const posting = /^issues\\/(\\d+)\\/comments$/.exec(endpoint.slice(prefix.length));
  const patching = /^issues\\/comments\\/(\\d+)$/.exec(endpoint.slice(prefix.length));
  if ((posting && args.includes("POST")) || (patching && args.includes("PATCH"))) {
    const body = payload().body;
    if (transport.failState && body.includes("agent-pipeline:state")) fail("HTTP 503 save response lost");
    let comment;
    if (posting) {
      transport.seq += 1;
      comment = { id: transport.seq, node_id: "transport-" + transport.seq, issue: Number(posting[1]), user: { login: identity[2] }, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", lastEditedAt: null, editor: null, body };
      transport.comments.push(comment);
    } else {
      comment = transport.comments.find(item => item.id === Number(patching[1]));
      if (!comment) fail("HTTP 404");
      comment.body = body;
      comment.lastEditedAt = "2026-10-21T00:00:00Z";
      comment.editor = { login: identity[2] };
    }
    if (body.includes("agent-pipeline:state")) Object.assign(comment, transport.stateReadback);
    // Model delayed visibility of an already authenticated predecessor save at
    // the ownership boundary, without fabricating coordination history.
    if (body.includes('"kind":"confirm"') && transport.stateAfterConfirm) {
      const state = transport.comments.find(item => item.issue === comment.issue && item.body.includes("agent-pipeline:state"));
      if (!state) fail("missing saved state for delayed visibility");
      state.body = transport.stateAfterConfirm;
      delete transport.stateAfterConfirm;
    }
    save();
    if (transport.loseStateResponse && body.includes("agent-pipeline:state")) fail("HTTP 503 response lost after save");
    if (args.includes("--silent")) send("");
    if (args.includes("--jq")) send(String(comment.id));
    json(comment);
  }
}
`;

/** @param {string} dir */
function executionTransportFiles(dir) {
  const file = path.join(dir, "execution-transport.json");
  return {
    transport: /** @param {unknown} state */ (state) => {
      fs.writeFileSync(file, JSON.stringify(state));
    },
    transportState: /** @returns {unknown} */ () =>
      JSON.parse(fs.readFileSync(file, "utf8")),
  };
}

export { EXECUTION_TRANSPORT, executionTransportFiles };
