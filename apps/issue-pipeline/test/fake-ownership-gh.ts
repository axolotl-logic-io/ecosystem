// The coordination half of a fake gh (fake-ownership.ts, #169): it answers
// the calls the real transport makes from what that transport wrote to the
// store `ownership.json` in `dir`, and exits. For a comment listing it
// answers nothing itself and returns the issue's records, which the fake
// appends to its own scripted comments, and `done`, which the fake calls
// once it has answered. With no store, it does nothing. The fake gh scripts
// load it with require(), so it has no top-level await.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SHA_LENGTH = 40;
const HEX = 16;
const COORDINATION_REF = "git/ref/heads/pipeline-coordination/";
const POSTED = /^issues\/(?<issue>\d+)\/comments$/u;
const LISTED = /^issues\/(?<issue>\d+)\/comments\?per_page=100$/u;
const QUIET = "1";
// A write in flight or retained: its journal (src/coordination-journal.ts).
const JOURNAL = /^coordination-(?:inflight|uncertain)[-.]/u;

// A coordination comment as the store keeps it, in GitHub's wire format.
interface StoredComment {
  id: number;
  node_id: string;
  issue: number;
  user: { login: string };
  created_at: string;
  updated_at: string;
  lastEditedAt: null;
  editor: null;
  body: string;
}

// The store fake-ownership.ts writes and this fake reads and updates.
interface Store {
  repo: string;
  base: string;
  owner: string;
  refs: Record<string, string>;
  commits: Record<string, { sha: string; tree: { sha: string } }>;
  comments: StoredComment[];
  seq: number;
  token: number;
  acquiring: boolean;
  takeover: boolean;
  afterWrite?: boolean;
  request: { number: number } | null;
}

interface Served {
  args: readonly string[];
  route: string;
  login: string;
  save: () => void;
}

function batchIds(args: readonly string[]): string[] {
  const ids: string[] = [];
  for (let at = 0; args.some((arg) => arg.startsWith(`c${at}=`)); at += 1) {
    const entry = args.find((arg) => arg.startsWith(`c${at}=`)) ?? "";
    ids.push(entry.slice(entry.indexOf("=") + 1));
  }
  return ids;
}

function send(text: string): never {
  fs.writeSync(1, text);
  process.exit(0);
}

function fail(text: string): never {
  fs.writeSync(2, text);
  process.exit(1);
}

// Whether the call changes GitHub.
function isWrite(args: readonly string[]): boolean {
  if (args.includes("-X") || args.includes("--method")) {
    return true;
  }
  const [command, sub = ""] = args;
  return (
    (command === "pr" || command === "issue") &&
    !["list", "view", "checks"].includes(sub)
  );
}

// Whether a write of issue `n` is still journaled in the ops request's run
// folder: the takeover waits until that write has settled, as a successor
// can't acquire past an open journal.
function journalOpen(env: NodeJS.ProcessEnv, n: number): boolean {
  const { ISSUE_PIPELINE_ROOT: root = "" } = env;
  const runs = path.join(root, "runs");
  if (root === "" || !fs.existsSync(runs)) {
    return false;
  }
  return fs.readdirSync(runs).some((slug) => {
    const dir = path.join(runs, slug, `issue-${n}`);
    return (
      fs.existsSync(dir) &&
      fs.readdirSync(dir).some((name) => JOURNAL.test(name))
    );
  });
}

// The request body on stdin.
function input(): { tree: string; ref: string; sha: string } {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function field(args: readonly string[], name: string): string {
  const found = args.find((arg) => arg.startsWith(`${name}=`)) ?? "";
  return found.slice(name.length + 1);
}

// A comment as GitHub's GraphQL API answers it.
interface CommentNode {
  databaseId: number;
  body: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  lastEditedAt: null;
  editor: null;
}

function nodeOf(item: StoredComment): CommentNode {
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

function serveRefs(own: Store, route: string): void {
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

function serveRefWrites(
  own: Store,
  args: readonly string[],
  route: string,
  save: () => void,
): void {
  if (!args.includes("POST")) {
    return;
  }
  if (route === "git/commits") {
    own.token += 1;
    const sha = own.token.toString(HEX).padStart(SHA_LENGTH, "0");
    const commit = { sha, tree: { sha: input().tree } };
    own.commits[sha] = commit;
    save();
    send(JSON.stringify(commit));
  }
  if (route === "git/refs") {
    const { ref, sha } = input();
    const name = ref.slice("refs/".length);
    if (own.refs[name] !== undefined) {
      fail("HTTP 422: Reference already exists");
    }
    own.refs[name] = sha;
    save();
    send(JSON.stringify({ object: { sha } }));
  }
}

function serveRecords(own: Store, { args, route, login, save }: Served): void {
  const body = field(args, "body");
  const { issue: posted } = POSTED.exec(route)?.groups ?? {};
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
  const items: StoredComment[] = [];
  for (const id of ids) {
    const item = own.comments.find((each) => each.node_id === id);
    if (item === undefined) {
      return;
    }
    items.push(item);
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
  const [first] = items;
  if (first !== undefined) {
    send(JSON.stringify({ data: { node: nodeOf(first) } }));
  }
}

// The request a takeover is armed for.
function requested(own: Store): { number: number } {
  if (own.request === null) {
    throw new Error("the ownership store has no request");
  }
  return own.request;
}

function serveOwnership(
  dir: string,
  args: readonly string[],
  login: string,
): { records: StoredComment[]; done: () => void } | null {
  const file = path.join(dir, "ownership.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  const own: Store = JSON.parse(fs.readFileSync(file, "utf8"));
  function save(): void {
    fs.writeFileSync(file, JSON.stringify(own));
  }
  // A successor takes the issue once this read is answered (takeover()).
  function done(): void {
    const { env } = process;
    const { FAKE_OWNERSHIP_QUIET: quiet } = env;
    if (
      !own.takeover ||
      own.afterWrite === true ||
      quiet === QUIET ||
      journalOpen(env, requested(own).number)
    ) {
      return;
    }
    own.takeover = false;
    own.acquiring = true;
    save();
    const taken = spawnSync(process.execPath, [own.owner, "successor"], {
      input: JSON.stringify(own.request),
      encoding: "utf8",
      env: Object.fromEntries([
        ...Object.entries(env),
        ["FAKE_OWNERSHIP_QUIET", QUIET],
      ]),
    });
    const after: Store = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...after, acquiring: false }));
    if (taken.status !== 0) {
      throw new Error(`the successor didn't take the issue: ${taken.stderr}`);
    }
  }
  // Armed after a write, the takeover waits for the request's first one.
  const { FAKE_OWNERSHIP_QUIET: quietCall } = process.env;
  if (own.afterWrite === true && quietCall !== QUIET && isWrite(args)) {
    own.afterWrite = false;
    save();
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
  const { issue: listed } = LISTED.exec(route)?.groups ?? {};
  if (listed === undefined) {
    return null;
  }
  const records = own.comments.filter((item) => item.issue === Number(listed));
  return { records, done };
}

export { serveOwnership };
