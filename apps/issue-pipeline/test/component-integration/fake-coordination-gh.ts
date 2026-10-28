// Coordination GitHub answers served through the shared persistent fake-gh
// protocol. Each request reads and commits the one store synchronously; the
// service serializes requests without filesystem locks or per-call Node.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  answer,
  exit,
  fail,
  print,
  type Reply,
  stdin,
} from "../support/signals/fake-gh-call.ts";
import {
  type Request,
  serveFakeGitHub,
} from "../support/signals/fake-gh-service.ts";
import {
  type FakeGhTransport,
  startFakeGhTransport,
} from "../support/signals/fake-github-test-kit.ts";

const SHA_WIDTH = 40;
const HEX = 16;
const FIRST_TOKEN = 0x10_00;
const CREATED = "2026-10-25T00:00:00Z";
const POSTED = /^issues\/(?<issue>\d+)\/comments$/u;
const LISTED = /^issues\/(?<issue>\d+)\/comments\?per_page=100$/u;
const BATCH_FIELD = /^c\d+$/u;

const COMMENT = z.object({
  issue: z.number(),
  id: z.number(),
  login: z.string(),
  body: z.string(),
  currentBody: z.string().optional(),
  editor: z.string().nullable().optional(),
});
const COMMIT = z.object({ sha: z.string(), tree: z.string() });
const STORE = z.object({
  repo: z.string(),
  login: z.string(),
  seq: z.number(),
  token: z.number(),
  comments: z.array(COMMENT),
  refs: z.record(z.string(), z.string()),
  commits: z.array(COMMIT),
  failPost: z.string().nullable(),
});
type Store = z.infer<typeof STORE>;
type Comment = z.infer<typeof COMMENT>;

function shaOf(n: number): string {
  return n.toString(HEX).padStart(SHA_WIDTH, "0");
}

// A new store for repository `repo`, whose landing account is `login`, with
// base branch `base` at one commit.
function newStore(repo: string, login: string, base: string): Store {
  const sha = shaOf(FIRST_TOKEN);
  return {
    repo,
    login,
    seq: 0,
    token: FIRST_TOKEN,
    comments: [],
    refs: { [`heads/${base}`]: sha },
    commits: [{ sha, tree: shaOf(FIRST_TOKEN - 1) }],
    failPost: null,
  };
}

function readStore(file: string): Store {
  return STORE.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
function writeStore(file: string, store: Store): void {
  fs.writeFileSync(file, JSON.stringify(store));
}

function reply(value: unknown): never {
  print(`${JSON.stringify(value)}\n`);
  return exit(0);
}

function restComment(comment: Comment): unknown {
  return Object.fromEntries([
    ["id", comment.id],
    ["node_id", `IC_${comment.id}`],
    ["user", { login: comment.login }],
    ["created_at", CREATED],
    ["updated_at", CREATED],
    ["body", comment.body],
  ]);
}
function editedAt(comment: Comment): typeof CREATED | null {
  if (comment.editor === undefined || comment.editor === null) {
    return null;
  }
  return CREATED;
}
function editorOf(comment: Comment): { login: string } | null {
  if (comment.editor === undefined || comment.editor === null) {
    return null;
  }
  return { login: comment.editor };
}
function nodeOf(store: Store, nodeId: string): unknown {
  const comment = store.comments.find((item) => `IC_${item.id}` === nodeId);
  if (comment === undefined) {
    return null;
  }
  return {
    databaseId: comment.id,
    body: comment.currentBody ?? comment.body,
    createdAt: CREATED,
    updatedAt: CREATED,
    lastEditedAt: editedAt(comment),
    author: { login: comment.login },
    editor: editorOf(comment),
  };
}

function fields(args: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  args.forEach((arg, at) => {
    const value = args[at + 1];
    if ((arg === "-f" || arg === "-F") && value !== undefined) {
      const split = value.indexOf("=");
      found.set(value.slice(0, split), value.slice(split + 1));
    }
  });
  return found;
}

function graphql(store: Store, args: readonly string[]): never {
  const given = fields(args);
  const single = given.get("id");
  if (single !== undefined) {
    reply({ data: { node: nodeOf(store, single) } });
  }
  const batch = [...given].filter(([name]) => BATCH_FIELD.test(name));
  reply({
    data: Object.fromEntries(
      batch.map(([name, id]) => [name, nodeOf(store, id)]),
    ),
  });
}

function listing(comments: readonly Comment[]): never {
  print(
    comments.map((item) => `${JSON.stringify(restComment(item))}\n`).join(""),
  );
  exit(0);
}

function post(store: Store, route: string, args: readonly string[]): void {
  const { issue } = POSTED.exec(route)?.groups ?? {};
  if (issue !== undefined) {
    const body = fields(args).get("body") ?? "";
    if (store.failPost !== null && body.includes(store.failPost)) {
      store.failPost = null;
      fail("HTTP 502: Bad Gateway");
    }
    store.seq += 1;
    store.comments.push({
      issue: Number(issue),
      id: store.seq,
      login: store.login,
      body,
    });
    reply({ id: store.seq });
  }
  const input: unknown = JSON.parse(stdin());
  if (route === "git/commits") {
    const { tree } = z.object({ tree: z.string() }).parse(input);
    store.token += 1;
    const sha = shaOf(store.token);
    store.commits.push({ sha, tree });
    reply({ sha, tree: { sha: tree } });
  }
  if (route === "git/refs") {
    const { ref, sha } = z
      .object({ ref: z.string(), sha: z.string() })
      .parse(input);
    const name = ref.slice("refs/".length);
    if (store.refs[name] !== undefined) {
      fail("HTTP 422: Reference already exists");
    }
    store.refs[name] = sha;
    reply({ ref, object: { sha } });
  }
  fail(`fake gh: unexpected POST ${route}`);
}

function get(store: Store, route: string): never {
  if (route === "issues/comments?per_page=100") {
    listing(store.comments);
  }
  const { issue } = LISTED.exec(route)?.groups ?? {};
  if (issue !== undefined) {
    listing(store.comments.filter((item) => item.issue === Number(issue)));
  }
  if (route.startsWith("git/ref/")) {
    const sha = store.refs[route.slice("git/ref/".length)];
    if (sha === undefined) {
      fail("HTTP 404: Not Found");
    }
    reply({ object: { sha } });
  }
  if (route.startsWith("git/commits/")) {
    const commit = store.commits.find(
      (item) => item.sha === route.slice("git/commits/".length),
    );
    if (commit === undefined) {
      fail("HTTP 404: Not Found");
    }
    reply({ sha: commit.sha, tree: { sha: commit.tree } });
  }
  fail(`fake gh: unexpected GET ${route}`);
}

function serve(file: string, args: readonly string[]): void {
  const store = readStore(file);
  try {
    if (args[0] !== "api") {
      fail(`fake gh: unexpected command ${args.join(" ")}`);
    }
    if (args[1] === "user") {
      print(`${store.login}\n`);
      exit(0);
    }
    if (args[1] === "graphql") {
      graphql(store, args);
    }
    const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const prefix = `repos/${store.repo}/`;
    if (!endpoint.startsWith(prefix)) {
      fail(`fake gh: unexpected endpoint ${endpoint}`);
    }
    const route = endpoint.slice(prefix.length);
    if (args.includes("POST")) {
      post(store, route, args);
    }
    get(store, route);
  } finally {
    writeStore(file, store);
  }
}

function main(): void {
  const [socket = "", file = "", , ready = ""] = process.argv.slice(2);
  readStore(file);
  serveFakeGitHub({
    socket,
    ready,
    call: (request: Request): Reply =>
      answer(request, () => serve(file, request.args)),
    read: (): string => JSON.stringify(readStore(file)),
    write: (text: string): void =>
      writeStore(file, STORE.parse(JSON.parse(text))),
  });
}

function startCoordinationGitHub(at: {
  root: string;
  bin: string;
  store: string;
  env: NodeJS.ProcessEnv;
}): FakeGhTransport {
  readStore(at.store);
  return startFakeGhTransport({
    root: at.root,
    bin: at.bin,
    world: at.store,
    log: path.join(at.root, "gh.log"),
    env: at.env,
    server: import.meta.filename,
  });
}

if (process.argv[1] === import.meta.filename) {
  main();
}

export type { Store };
export { newStore, readStore, startCoordinationGitHub, writeStore };
