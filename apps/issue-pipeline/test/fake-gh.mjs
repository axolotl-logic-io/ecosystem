// @ts-check
// A fake `gh` for tests of the modules that call GitHub. installFakeGh() puts a
// `gh` script first on PATH, which the ops modules' run() passes on. The script
// records each call's arguments, then answers with the first queued reply whose
// `when` text appears in its arguments, and removes that reply. A reply may
// also give `stderr` to print and `code` to exit with, as a refused command
// does, and `keep` to answer every matching call rather than only the first,
// so a test needn't know how often a read is made. A call that matches no
// reply fails when requireReplies() enabled strict mode; legacy fixtures retain
// their empty-success default. Neither mode can invoke system gh.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

// The gh script's file mode: executable by its owner, readable by all.
const EXECUTABLE = 0o755;
const CALL_ARGS = z.array(z.string());

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
 * @property {() => void} requireReplies fail every unmatched read or write
 * @property {(replies: readonly GhReply[]) => void} reply
 * @property {() => string[][]} calls
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
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(args) + "\\n");
const file = path.join(dir, "replies.json");
const replies = JSON.parse(fs.readFileSync(file, "utf8"));
const text = args.join(" ");
const at = replies.findIndex((reply) => text.includes(reply.when));
if (at >= 0) {
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
  process.stdout.write(stdout);
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
  if (reply.keep !== true) {
    replies.splice(at, 1);
    fs.writeFileSync(file, JSON.stringify(replies));
  }
} else if (fs.existsSync(path.join(dir, "strict")) || (args[0] === "pr" && args[1] === "list" && args.includes("all"))) {
  process.stderr.write("unsupported private fake gh request: " + text); process.exitCode = 1;
}
const body = args.find(arg => arg.startsWith("body="))?.slice(5);
const endpoint = args.find(arg => arg.startsWith("repos/"));
if (at >= 0 && (process.exitCode ?? 0) === 0 && args.includes("PATCH") && body?.includes("<!-- agent-pipeline:state")) {
  for (const reply of replies.filter(item => item.persistState)) {
    const comments = reply.stdout.split("\\n").filter(Boolean).map(line => JSON.parse(line));
    for (const comment of comments) {
      if (endpoint?.endsWith("/comments/" + comment.id)) comment.body = body;
    }
    reply.stdout = comments.map(comment => JSON.stringify(comment)).join("\\n");
  }
  fs.writeFileSync(file, JSON.stringify(replies));
}
`;
}

/**
 * Puts a fake gh first on PATH and returns it.
 * @returns {FakeGh}
 */
function installFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(path.join(dir, "gh"), script(dir), { mode: EXECUTABLE });
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
    requireReplies() {
      fs.writeFileSync(path.join(dir, "strict"), "true");
    },
    reply(replies) {
      fs.writeFileSync(path.join(dir, "replies.json"), JSON.stringify(replies));
      fs.writeFileSync(callsFile, "");
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
 * @param {{ id: number, body: string, login: string, created: string, updated?: string }} comment
 * @returns {object}
 */
function githubComment({ id, body, login, created, updated }) {
  const comment = { id, body, user: { login }, created_at: created };
  if (updated === undefined) {
    return comment;
  }
  return { ...comment, updated_at: updated };
}

export { commentLines, githubComment, installFakeGh };
