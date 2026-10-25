// @ts-check
// A fake `gh` for tests of the modules that call GitHub. installFakeGh() puts a
// `gh` script first on PATH, which the ops modules' run() passes on. The script
// records each call's arguments, then answers with the first queued reply whose
// `when` text appears in its arguments, and removes that reply. A reply may
// also give `stderr` to print and `code` to exit with, as a refused command
// does, and `keep` to answer every matching call rather than only the first,
// so a test needn't know how often a read is made. A call that matches no
// reply fails closed. No request can invoke system gh.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  EXECUTION_TRANSPORT,
  executionTransportFiles,
} from "./fake-execution-transport.mjs";
import { BATCH_GRAPHQL } from "./fake-graphql-batch.mjs";
import { forgetOwners, OWNERSHIP_GH, registerFake } from "./fake-ownership.mjs";

// The gh script's file mode: executable by its owner, readable by all.
const EXECUTABLE = 0o755;
const CALL_ARGS = z.array(z.string());
const AUTHENTICATED_CALL = z.object({
  identity: z.enum(["dev", "merge"]),
  args: CALL_ARGS,
});

/**
 * One queued answer: the text a call's arguments must contain, and what gh
 * prints and exits with.
 * @typedef {object} GhReply
 * @property {string} when
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number} [code]
 * @property {boolean} [keep] answer every matching call, not only the first
 * @property {boolean} [persistState] apply real state PATCHes to this saved comment fixture
 * @property {{ origin: string, base: string, head: string, sha: string }} [branchMerge] exact local merge mutation
 * @property {{ repo: string, ref: string }} [headRef] local origin of this OPEN PR's actual head
 */

/**
 * The fake gh: reply() queues answers and forgets earlier calls; calls() lists
 * each call's arguments, in order; writes(isRead) lists only the calls that
 * change GitHub, so a test can check what GitHub would show without pinning
 * the reads. A test passes src/github.ts's ghIsRead as `isRead`: this file
 * imports no src module, since tests set the pipeline root before src loads.
 * @typedef {object} FakeGh
 * @property {string} dir the folder holding the script and its logs
 * @property {(state: unknown) => void} transport
 * @property {() => unknown} transportState
 * @property {() => void} requireReplies fail every unmatched read or write
 * @property {(replies: readonly GhReply[]) => void} reply
 * @property {() => string[][]} loginCalls
 * @property {() => string[][]} calls
 * @property {() => { identity: "dev" | "merge", args: string[] }[]} authenticatedCalls
 * @property {(isRead: (args: readonly string[]) => boolean) => string[][]} writes
 */

/**
 * @param {string} dir
 * @returns {string}
 */
function script(dir) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const token = process.env.GH_TOKEN ?? "";
const identity = /^fake-pipeline-(dev|merge)--(.+)$/.exec(token);
if (!identity) throw new Error("missing fake bot credential");
let expected = "merge";
if (args[0] === "pr" && ["create", "edit", "reopen", "close", "ready"].includes(args[1])) expected = "dev";
if (args[0] === "api" && args.includes("DELETE") && args.some(arg => /^repos\\/[^/]+\\/[^/]+\\/git\\/refs\\/heads\\//u.test(arg))) expected = "dev";
if (!(args[0] === "api" && args[1] === "user") && identity[1] !== expected) throw new Error("wrong bot identity for operation");
const quiet = process.env.FAKE_OWNERSHIP_QUIET === "1";
if (args[0] === "api" && args[1] === "user") {
  if (!quiet) fs.appendFileSync(path.join(dir, "logins.jsonl"), JSON.stringify(args) + "\\n");
  if (!JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8")).some(reply => reply.when.startsWith("api user") && args.join(" ").includes(reply.when))) {
    process.stdout.write(identity[2] + "\\n"); process.exit(0);
  }
}
${BATCH_GRAPHQL}
${EXECUTION_TRANSPORT}
${OWNERSHIP_GH}
if (args[0] === "api" && args[1] === "graphql" && !JSON.parse(fs.readFileSync(path.join(dir, "replies.json"), "utf8")).some(reply => args.join(" ").includes(reply.when))) {
  const comments = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
  const nodeOf = id => {
    const comment = comments.find(item => item.node_id === id);
    if (!comment) throw new Error("unmatched comment provenance request");
    return { databaseId: comment.id, body: comment.body, author: comment.user, createdAt: comment.created_at, updatedAt: comment.updated_at ?? comment.created_at, lastEditedAt: comment.lastEditedAt, editor: comment.editor };
  };
  const batch = batchIds(args);
  if (batch) { fs.writeSync(1, batchAnswer(batch, nodeOf)); process.exit(0); }
  const id = args.find(arg => arg.startsWith("id="))?.slice(3);
  fs.writeSync(1, JSON.stringify({ data: { node: nodeOf(id) } })); process.exit(0);
}
if (!quiet) {
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
  fs.appendFileSync(path.join(dir, "identities.jsonl"), JSON.stringify({ identity: identity[1], args }) + "\\n");
}
const file = path.join(dir, "replies.json");
const replies = JSON.parse(fs.readFileSync(file, "utf8"));
const text = args.join(" ");
let at = replies.findIndex((reply) => text.includes(reply.when));
// With ownership on, each ops request lists the comments for every
// ownership read too, so a listing reply is the snapshot of one request:
// the next request's first listing uses it up and pins the next one.
if (ownershipListing && !quiet && at >= 0) {
  const pinFile = path.join(dir, "listing-pin.json");
  const pin = fs.existsSync(pinFile) ? JSON.parse(fs.readFileSync(pinFile, "utf8")) : null;
  const pinned = pin ? replies.findIndex(reply => reply.pin === pin.id) : -1;
  if (pin?.ppid === process.ppid && pinned >= 0) {
    at = pinned;
  } else {
    if (pinned >= 0 && replies[pinned].keep !== true) replies.splice(pinned, 1);
    at = replies.findIndex((reply) => text.includes(reply.when));
    if (at >= 0) {
      const id = String(process.pid) + ":" + String(Date.now());
      replies[at].pin = id;
      fs.writeFileSync(pinFile, JSON.stringify({ ppid: process.ppid, id }));
    }
    fs.writeFileSync(file, JSON.stringify(replies));
  }
}
if (at < 0 && ownershipListing) {
  const lines = ownershipListing.records.map(item => JSON.stringify(item));
  fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(ownershipListing.records));
  process.stdout.write(lines.join("\\n"));
} else if (at >= 0) {
  const reply = replies[at];
  let stdout = reply.stdout ?? "";
  if (reply.branchMerge) {
    const { origin, base, head, sha } = reply.branchMerge;
    const expected = ["api", "repos/o/r/merges", "--method", "POST", "--include", "-f", "base=" + base, "-f", "head=" + head];
    if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error("unsupported local branch merge");
    const git = (...argv) => execFileSync("git", ["--git-dir", origin, ...argv], { encoding: "utf8" }).trim();
    const parent = git("rev-parse", "refs/heads/" + base);
    if (git("show", "-s", "--format=%P", sha) !== parent + " " + head) throw new Error("invalid local branch merge graph");
    git("update-ref", "refs/heads/" + base, sha, parent);
  }
  if (reply.headRef) {
    const view = JSON.parse(stdout);
    view.headRefOid = execFileSync("git", ["-C", reply.headRef.repo, "rev-parse", reply.headRef.ref], { encoding: "utf8" }).trim();
    stdout = JSON.stringify(view);
  }
  if (ownershipListing) {
    stdout = [...stdout.split("\\n").filter(Boolean), ...ownershipListing.records.map(item => JSON.stringify(item))].join("\\n");
  }
  if (args.some(arg => arg.includes("/comments?"))) {
    const current = stdout.split("\\n").filter(Boolean).map(line => JSON.parse(line));
    fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(current));
  }
  process.stdout.write(stdout);
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
  if (reply.keep !== true && !ownershipListing) {
    replies.splice(at, 1);
    fs.writeFileSync(file, JSON.stringify(replies));
  }
} else if (fs.existsSync(path.join(dir, "ownership.json")) && args.includes("-X") && args.some(arg => arg.startsWith("body=") && arg.includes("<!-- agent-pipeline:state"))) {
  // With ownership on, GitHub takes an unscripted state save as it would.
  at = replies.length;
} else {
  process.stderr.write("unsupported private fake gh request: " + text); process.exitCode = 1;
}
const body = args.find(arg => arg.startsWith("body="))?.slice(5);
const endpoint = args.find(arg => arg.startsWith("repos/"));
// With ownership on, a bound claim reads its state checkpoint back, so the
// listings show a saved state as GitHub would: edited in place, or posted.
const ownershipOn = fs.existsSync(path.join(dir, "ownership.json"));
const endpointParts = (endpoint ?? "").split("/");
const postedState = endpointParts.length === 6 && endpointParts[3] === "issues" && endpointParts[5] === "comments" ? [null, endpointParts[4]] : null;
if (ownershipOn && at >= 0 && (process.exitCode ?? 0) === 0 && args.includes("POST") && postedState && body?.includes("<!-- agent-pipeline:state")) {
  const id = Number(replies[at]?.stdout?.trim()) || 700000 + replies.length + Number(String(Date.now()).slice(-4));
  const comment = { id, node_id: "comment-" + id, body, user: { login: identity[2] }, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", lastEditedAt: null, editor: null };
  if (at === replies.length && args.includes("--jq")) process.stdout.write(String(id));
  for (const reply of replies.filter(item => item.when.includes("issues/" + postedState[1] + "/comments?"))) {
    reply.stdout = [...(reply.stdout ?? "").split("\\n").filter(Boolean), JSON.stringify(comment)].join("\\n");
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify([...saved, comment]));
  fs.writeFileSync(file, JSON.stringify(replies));
}
if (at >= 0 && (process.exitCode ?? 0) === 0 && args.includes("PATCH") && body?.includes("<!-- agent-pipeline:state")) {
  for (const reply of replies.filter(item => item.persistState || (ownershipOn && item.when.includes("/comments?") && item.stdout))) {
    const comments = reply.stdout.split("\\n").filter(Boolean).map(line => JSON.parse(line));
    for (const comment of comments) {
      if (endpoint?.endsWith("/comments/" + comment.id)) {
        comment.body = body;
        const saved = JSON.parse(fs.readFileSync(path.join(dir, "comments.json"), "utf8"));
        const current = saved.find(item => item.id === comment.id);
        if (current) current.body = body;
        fs.writeFileSync(path.join(dir, "comments.json"), JSON.stringify(saved));
      }
    }
    reply.stdout = comments.map(comment => JSON.stringify(comment)).join("\\n");
  }
  fs.writeFileSync(file, JSON.stringify(replies));
}
if (ownershipListing) ownershipListing.done();
`;
}

/** @param {string} file @returns {string[][]} */
function readCallLog(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => CALL_ARGS.parse(JSON.parse(line)));
}

/**
 * Puts a fake gh first on PATH and returns it.
 * @returns {FakeGh}
 */
function installFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(path.join(dir, "gh"), script(dir), { mode: EXECUTABLE });
  registerFake(dir);
  const { PATH: searchPath } = process.env;
  Object.assign(process.env, { PATH: `${dir}${path.delimiter}${searchPath}` });
  const callsFile = path.join(dir, "calls.jsonl");
  /** @returns {string[][]} */
  function calls() {
    return fs
      .readFileSync(callsFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => CALL_ARGS.parse(JSON.parse(line)));
  }
  return {
    dir,
    ...executionTransportFiles(dir),
    loginCalls: () => readCallLog(path.join(dir, "logins.jsonl")),
    requireReplies() {
      fs.writeFileSync(path.join(dir, "strict"), "true");
    },
    authenticatedCalls() {
      return fs
        .readFileSync(path.join(dir, "identities.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => AUTHENTICATED_CALL.parse(JSON.parse(line)));
    },
    reply(replies) {
      forgetOwners();
      fs.rmSync(path.join(dir, "listing-pin.json"), { force: true });
      fs.writeFileSync(path.join(dir, "logins.jsonl"), "");
      fs.writeFileSync(path.join(dir, "identities.jsonl"), "");
      fs.writeFileSync(path.join(dir, "replies.json"), JSON.stringify(replies));
      fs.writeFileSync(callsFile, "");
      const comments = replies.flatMap((reply) => {
        if (!reply.when.includes("comments") || reply.stdout === undefined) {
          return [];
        }
        return reply.stdout
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              const item = JSON.parse(line);
              if (typeof item.id === "number") {
                return [item];
              }
            } catch {
              return [];
            }
            return [];
          });
      });
      fs.writeFileSync(
        path.join(dir, "comments.json"),
        JSON.stringify(comments),
      );
    },
    calls,
    writes(isRead) {
      return calls().filter((args) => !isRead(args));
    },
  };
}

/**
 * gh's answer to listComments' `--jq '.[] | @json'`: one comment per line.
 * @param {readonly unknown[]} comments
 * @returns {string}
 */
function commentLines(comments) {
  return comments.map((item) => JSON.stringify(item)).join("\n");
}

/**
 * A comment as GitHub's REST API returns it, which names its times in
 * snake_case; `updated` is left out when not given.
 * @param {{ id: number, body: string, login: string, created: string, updated?: string, nodeId?: string }} comment
 */
function githubComment({
  id,
  body,
  login,
  created,
  updated,
  nodeId = `comment-${id}`,
}) {
  const comment = {
    id,
    node_id: nodeId,
    body,
    user: { login },
    created_at: created,
    lastEditedAt: null,
    editor: null,
  };
  if (updated === undefined) {
    return comment;
  }
  return { ...comment, updated_at: updated };
}

// A genuine claim wire record; callers may vary body/provenance to test refusals.
/** @param {{id: number, lane: string, sweep: string, login: string, at: string}} claim */
function claimComment({ id, lane, sweep, login, at }) {
  return githubComment({
    id,
    login,
    created: at,
    updated: at,
    body: `**🤖 issue-pipeline · claim**\n<!-- agent-pipeline:comment role=claim -->\n\nLane \`${lane}\` is claiming this issue.\n<!-- agent-pipeline:claim lane=${lane} sweep=${sweep} -->`,
  });
}

export { claimComment, commentLines, githubComment, installFakeGh };
