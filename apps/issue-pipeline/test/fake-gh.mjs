// @ts-check
// A fake `gh` for tests of the modules that call GitHub. installFakeGh() puts a
// `gh` script first on PATH, which the ops modules' run() passes on. The script
// records each call's arguments, then answers with the first queued reply whose
// `when` text appears in its arguments, and removes that reply. A reply may
// also give `stderr` to print and `code` to exit with, as a refused command
// does. A call that matches no reply prints nothing and succeeds.
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
 */

/**
 * The fake gh: reply() queues answers and forgets earlier calls; calls() lists
 * each call's arguments, in order.
 * @typedef {object} FakeGh
 * @property {(replies: readonly GhReply[]) => void} reply
 * @property {() => string[][]} calls
 */

/**
 * @param {string} dir
 * @returns {string}
 */
function script(dir) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
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
  process.stdout.write(reply.stdout ?? "");
  process.stderr.write(reply.stderr ?? "");
  process.exitCode = reply.code ?? 0;
  replies.splice(at, 1);
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
  return {
    reply(replies) {
      fs.writeFileSync(path.join(dir, "replies.json"), JSON.stringify(replies));
      fs.writeFileSync(callsFile, "");
    },
    calls() {
      return fs
        .readFileSync(callsFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => CALL_ARGS.parse(JSON.parse(line)));
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
