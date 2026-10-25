// The job tests' private GitHub coordination surface (#150, #167): the git
// refs and commits the real transport (src/execution.ts) creates, and the
// coordination comments it appends and reads back with their provenance. It
// stores exactly what the real code wrote and never synthesizes a request,
// an owner confirmation or a release, though a test may make it lose a
// release's response. fake-job-authority.ts's gh runs it
// first; it exits for each call it answers and falls through for any other.
import fs from "node:fs";
import path from "node:path";
import type { Record as CoordinationRecord } from "../../src/coordination-records.ts";
import { BATCH_GRAPHQL } from "../fake-graphql-batch.ts";

// The base commit and tree the coordination tokens descend from.
const SHA_LENGTH = 40;
const BASE_SHA = JSON.stringify("b".repeat(SHA_LENGTH));
const BASE_TREE = JSON.stringify("c".repeat(SHA_LENGTH));

// Runs inside the fake gh, after `cfg`, `args`, `root` and `tokenIdentity`.
const COORDINATION_GH = `
${BATCH_GRAPHQL}
const coordinationFile = root + "/coordination.json";
const coordinationBase = "heads/" + (cfg.baseBranch ?? "main");
const coordination = fs.existsSync(coordinationFile)
  ? JSON.parse(fs.readFileSync(coordinationFile, "utf8"))
  : { refs: { [coordinationBase]: ${BASE_SHA} }, commits: { ${BASE_SHA}: { sha: ${BASE_SHA}, tree: { sha: ${BASE_TREE} } } }, comments: [], seq: 900, token: 0 };
const coordinationEndpoint = args.find(arg => arg.startsWith("repos/")) ?? "";
const coordinationPrefix = "repos/" + cfg.repo + "/";
const coordinationRoute = coordinationEndpoint.slice(coordinationPrefix.length);
const coordinationSave = () => fs.writeFileSync(coordinationFile, JSON.stringify(coordination));
const coordinationLog = () => fs.appendFileSync(root + "/coordination.log", JSON.stringify(args) + "\\n");
const coordinationSend = text => { coordinationLog(); process.stdout.write(text); process.exit(0); };
const coordinationFail = text => { coordinationLog(); process.stderr.write(text); process.exit(1); };
const coordinationInput = () => JSON.parse(fs.readFileSync(0, "utf8"));
const stateNode = () => {
  const saved = JSON.parse(fs.readFileSync(root + "/authority-state.json", "utf8"));
  if (!saved) return [];
  return [{ id: 1, node_id: "comment-1", user: { login: cfg.mergeAccount }, created_at: "2026-10-18T00:00:00Z", body: "<!-- agent-pipeline:state\\n" + JSON.stringify(saved) + "\\n-->" }];
};
if (coordinationEndpoint.startsWith(coordinationPrefix)) {
  if (coordinationRoute.startsWith("git/ref/")) {
    const sha = coordination.refs[coordinationRoute.slice("git/ref/".length)];
    if (!sha) coordinationFail("HTTP 404: Not Found");
    coordinationSend(JSON.stringify({ object: { sha } }));
  }
  if (coordinationRoute === "git/commits" && args.includes("POST")) {
    const body = coordinationInput();
    coordination.token += 1;
    const sha = coordination.token.toString(16).padStart(40, "0");
    coordination.commits[sha] = { sha, tree: { sha: body.tree } };
    coordinationSave(); coordinationSend(JSON.stringify(coordination.commits[sha]));
  }
  if (coordinationRoute.startsWith("git/commits/")) {
    const commit = coordination.commits[coordinationRoute.slice("git/commits/".length)];
    if (!commit) coordinationFail("HTTP 404: Not Found");
    coordinationSend(JSON.stringify(commit));
  }
  if (coordinationRoute === "git/refs" && args.includes("POST")) {
    const body = coordinationInput();
    const name = body.ref.slice("refs/".length);
    if (coordination.refs[name]) coordinationFail("HTTP 422: Reference already exists");
    coordination.refs[name] = body.sha; coordinationSave();
    coordinationSend(JSON.stringify({ object: { sha: body.sha } }));
  }
  const listed = /^issues\\/(\\d+)\\/comments\\?per_page=100$/.exec(coordinationRoute);
  if (listed) {
    const rows = [...stateNode(), ...coordination.comments.filter(item => item.issue === Number(listed[1]))];
    coordinationSend(rows.map(item => JSON.stringify(item) + "\\n").join(""));
  }
  const posted = /^issues\\/(\\d+)\\/comments$/.exec(coordinationRoute);
  const body = args.find(arg => arg.startsWith("body="))?.slice("body=".length) ?? "";
  if (posted && args.includes("POST") && body.includes("agent-pipeline:coordination")) {
    // A release fault (coordination-fault.json): "lost" stores the release
    // and loses its response; "unconfirmed" loses both.
    const fault = fs.existsSync(root + "/coordination-fault.json") ? JSON.parse(fs.readFileSync(root + "/coordination-fault.json", "utf8")) : null;
    const releasing = body.includes('"kind":"release"');
    if (releasing && fault?.release === "unconfirmed") coordinationFail("HTTP 502: Bad Gateway");
    coordination.seq += 1;
    coordination.comments.push({ id: coordination.seq, node_id: "coordination-" + coordination.seq, issue: Number(posted[1]), user: { login: tokenIdentity[2] }, created_at: "2026-10-18T00:00:00Z", body });
    coordinationSave();
    if (releasing && fault?.release === "lost") coordinationFail("HTTP 502: Bad Gateway");
    coordinationSend("");
  }
}
const coordinationNode = id => {
  const comment = coordination.comments.find(item => item.node_id === id);
  if (comment) return { databaseId: comment.id, body: comment.body, author: comment.user, createdAt: comment.created_at, updatedAt: comment.created_at, lastEditedAt: null, editor: null };
  const [saved] = stateNode();
  if (saved && saved.node_id === id) return { databaseId: saved.id, body: saved.body, author: saved.user, createdAt: saved.created_at, updatedAt: saved.created_at, lastEditedAt: null, editor: null };
  return null;
};
if (args[0] === "api" && args[1] === "graphql") {
  const batch = batchIds(args);
  if (batch) coordinationSend(batchAnswer(batch, coordinationNode));
  const id = args.find(arg => arg.startsWith("id="))?.slice("id=".length);
  if (coordination.comments.some(item => item.node_id === id)) {
    coordinationSend(JSON.stringify({ data: { node: coordinationNode(id) } }));
  }
}
`;

// A coordination record the real transport wrote, with its comment's id.
type CoordinationRow = CoordinationRecord & { id: number };

// The coordination records the real transport wrote in `root`, parsed.
function coordinationRecords(root: string): CoordinationRow[] {
  const file = path.join(root, "coordination.json");
  if (!fs.existsSync(file)) {
    return [];
  }
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  return store.comments.map(({ id, body }: { id: number; body: string }) => ({
    id,
    ...JSON.parse(body.split("\n")[1] ?? "null"),
  }));
}

export type { CoordinationRow };
export { COORDINATION_GH, coordinationRecords };
