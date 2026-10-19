// @ts-check
// Only the fixture's local API file is mutated. Unknown requests fail closed.
const PR = 42;
const FAKE_ADOPTION_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const identity = /^fake-pipeline-(dev|merge)--(.+)$/.exec(process.env.GH_TOKEN ?? "");
if (!identity) throw new Error("not a fake credential");
if (args[0] === "api" && args[1] === "user") { process.stdout.write(identity[2]); process.exit(0); }
const endpoint = args.find(arg => arg.startsWith("repos/"));
const repo = endpoint?.split("/").slice(1, 3).join("/") ?? args[args.indexOf("-R") + 1];
const file = path.join(process.env.ISSUE_PIPELINE_ROOT, "adopt-api", repo.replaceAll("/", "__") + ".json");
let data;
if (args[0] === "api" && args[1] === "graphql") {
  const id = args.find(arg => arg.startsWith("id="))?.slice(3);
  const saved = path.join(process.env.ISSUE_PIPELINE_ROOT, "adopt-api", id.split(":")[0] + ".json");
  data = JSON.parse(fs.readFileSync(saved, "utf8"));
  if (data.mode === "provenance-failure") throw new Error("provenance unavailable");
  const c = data.comments.find(c => c.node_id === id);
  const editor = data.mode === "foreign-editor" ? { login: "visitor" } : null;
  process.stdout.write(JSON.stringify({ data: { node: { databaseId: c.id, body: c.body, author: c.user,
    createdAt: c.created_at, updatedAt: c.updated_at, lastEditedAt: editor ? "2026-10-19T00:00:00Z" : null, editor } } }));
  process.exit(0);
}
data = JSON.parse(fs.readFileSync(file, "utf8"));
data.calls.push(args);
const save = () => fs.writeFileSync(file, JSON.stringify(data));
const reply = value => { save(); process.stdout.write(JSON.stringify(value)); process.exit(0); };
const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
if (args[0] === "pr" && args[1] === "list" && args.includes("all")) reply(data.history);
if (args[0] === "pr" && args[1] === "reopen") {
  if (identity[1] !== "dev") throw new Error("wrong reopen identity");
  data.pr.state = "open"; reply(null);
}
if (identity[1] !== "merge") throw new Error("wrong read/comment identity");
if (args[0] === "pr" && args[1] === "view") reply({ number: data.pr.number,
  state: data.pr.merged ? "MERGED" : data.pr.state.toUpperCase(), headRefName: data.pr.head.ref,
  headRefOid: data.pr.head.sha, baseRefName: data.pr.base.ref, isCrossRepository: false,
  mergeCommit: data.pr.merged ? { oid: data.pr.merge_commit_sha } : null });
if (endpoint === "repos/" + repo) reply({ full_name: data.actualRepo ?? repo });
if (endpoint === "repos/" + repo + "/issues/7") reply({ number: 7, repository_url: "https://api.github.com/repos/" + repo,
  title: "Retained work", body: "Requirements", user: { login: "alice" }, labels: [], state: "open" });
if (endpoint?.includes("/collaborators/")) reply({ permission: "write" });
if (endpoint?.includes("/pulls/")) {
  data.prReads = (data.prReads ?? 0) + 1;
  if (data.mode === "changed-head" && data.prReads > 1) data.pr.head.sha = "f".repeat(40);
  if (data.mode === "unreadable-pr") throw new Error("PR unavailable");
  if (data.mode === "interrupted-validation" && data.prReads === 2) { data.mode = "normal"; save(); throw new Error("interrupted validation"); }
  reply(data.pr);
}
if (endpoint?.endsWith("/comments?per_page=100")) {
  save(); process.stdout.write(data.comments.map(c => JSON.stringify(c)).join("\\n")); process.exit(0);
}
if (method === "POST" && endpoint?.endsWith("/comments")) {
  if (data.mode === "lost-before-post") { data.mode = "normal"; save(); throw new Error("lost request before post"); }
  const id = data.comments.length + 100;
  const body = args.find(arg => arg.startsWith("body="))?.slice(5);
  const c = { id, node_id: repo.replaceAll("/", "__") + ":" + id, body, user: { login: identity[2] },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), lastEditedAt: null, editor: null };
  data.comments.push(c);
  if (data.mode === "lost-after-post") { data.mode = "normal"; save(); throw new Error("lost reply after post"); }
  reply(c);
}
if (method === "PATCH" && endpoint?.includes("/issues/comments/")) {
  const id = Number(endpoint.split("/").at(-1));
  const c = data.comments.find(c => c.id === id);
  c.body = args.find(arg => arg.startsWith("body="))?.slice(5);
  reply(c);
}
if (endpoint?.includes("/labels")) reply([]);
throw new Error("unexpected fake request " + JSON.stringify(args));
`;

/** @param {string} repo @param {object} legacy @param {{ ref: string, sha: string }} source @param {{ ref: string, sha: string }} base */
function initialApi(repo, legacy, source, base) {
  /** @type {import("./adoption-test-kit.mjs").Api} */
  const data = {
    mode: "normal",
    calls: [],
    history: [{ number: PR }],
    pr: {
      number: PR,
      state: "open",
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ...source, repo: { full_name: repo } },
      base: { ...base, repo: { full_name: repo } },
    },
    comments: [
      {
        id: 1,
        body: `<!-- agent-pipeline:state\n${JSON.stringify(legacy)}\n-->`,
        user: { login: "old-bot" },
        created_at: "2026-10-17T00:00:00Z",
      },
    ],
  };
  return data;
}

export { FAKE_ADOPTION_GH, initialApi };
