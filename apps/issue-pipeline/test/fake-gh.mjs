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

// Returns { reply, calls }: reply(replies) queues [{ when, stdout, stderr?,
// code? }] and
// forgets earlier calls; calls() lists each call's arguments, in order.
function installFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-"));
  fs.writeFileSync(path.join(dir, "gh"), script(dir), { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
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
        .map((line) => JSON.parse(line));
    },
  };
}

// gh's answer to listComments' `--jq '.[] | @json'`: one comment per line.
function commentLines(comments) {
  return comments.map((item) => JSON.stringify(item)).join("\n");
}

export { commentLines, installFakeGh };
