// A fake `gh` for the coordination transport: the calls src/execution.ts,
// src/comments.ts and src/comment-authority.ts make, answered from one JSON
// store, `FAKE_GH_STORE`, that every process shares. A lock directory beside
// the store serializes the calls of concurrent processes, as GitHub
// serializes its writes. A comment POST whose body contains the store's
// `failPost` text fails without landing, once: a lost write.
//
// The test's PATH runs it as `gh` through a shell wrapper (writeFakeGh).
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const SHA_WIDTH = 40;
const HEX = 16;
const FIRST_TOKEN = 0x10_00;
const CREATED = "2026-10-25T00:00:00Z";
const POSTED = /^issues\/(?<issue>\d+)\/comments$/u;
const LISTED = /^issues\/(?<issue>\d+)\/comments\?per_page=100$/u;
const BATCH_FIELD = /^c\d+$/u;
const EXECUTABLE = 0o755;

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

class Exit extends Error {
  readonly code: number;
  readonly out: string;
  constructor(code: number, out: string) {
    super(out);
    this.code = code;
    this.out = out;
  }
}
function reply(value: unknown): never {
  throw new Exit(0, `${JSON.stringify(value)}\n`);
}
function fail(message: string): never {
  throw new Exit(1, message);
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
  throw new Exit(
    0,
    comments.map((item) => `${JSON.stringify(restComment(item))}\n`).join(""),
  );
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
  const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
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
      throw new Exit(0, `${store.login}\n`);
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

// Runs `work` holding the store's lock: a directory, which mkdir makes
// atomically.
function locked(file: string, work: () => void): void {
  const lock = `${file}.lock`;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
  try {
    work();
  } finally {
    fs.rmdirSync(lock);
  }
}

function main(): void {
  const { FAKE_GH_STORE: file } = process.env;
  if (file === undefined) {
    process.stderr.write("fake gh: FAKE_GH_STORE is not set\n");
    process.exit(1);
  }
  try {
    locked(file, () => serve(file, process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof Exit)) {
      throw error;
    }
    if (error.code === 0) {
      process.stdout.write(error.out);
    } else {
      process.stderr.write(`${error.out}\n`);
    }
    process.exitCode = error.code;
  }
}

// The fake's own path, which a shell wrapper named `gh` in `bin` runs with
// this Node, caching its compiled code beside `bin`.
function writeFakeGh(bin: string): void {
  fs.mkdirSync(bin, { recursive: true });
  const wrapper = path.join(bin, "gh");
  const cache = path.join(path.dirname(bin), "compile-cache");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nNODE_COMPILE_CACHE="${cache}" exec "${process.execPath}" "${import.meta.filename}" "$@"\n`,
  );
  fs.chmodSync(wrapper, EXECUTABLE);
}

if (process.argv[1] === import.meta.filename) {
  main();
}

export type { Store };
export { newStore, readStore, writeFakeGh, writeStore };
