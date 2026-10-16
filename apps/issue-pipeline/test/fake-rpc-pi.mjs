// @ts-check
// The stage job tests' fakes: the ops.mjs and RPC `pi` sources that
// job-test-kit.mjs installs, and builders for the records pi prints.

// Answers each op from replies.json and logs the request to ops.log. A push
// whose reply sets `git` pushes the request's checkout's HEAD to the
// issue's branch on origin first, as the real push op would.
const FAKE_OPS = `import { execFileSync } from "node:child_process";
import fs from "node:fs";
const dir = import.meta.dirname;
const input = fs.readFileSync(0, "utf8");
const request = JSON.parse(input.split("BEGIN_OPS_REQUEST")[1].split("END_OPS_REQUEST")[0]);
fs.appendFileSync(dir + "/ops.log", JSON.stringify(request) + "\\n");
const replies = JSON.parse(fs.readFileSync(dir + "/replies.json", "utf8"));
if (request.op === "push" && replies.push?.git) {
  execFileSync("git", ["-C", request.checkout.dir, "push", "--quiet", "origin", "HEAD:refs/heads/agent/issue-7"], {
    env: { ...process.env, ISSUE_PIPELINE_OPS: "1" },
  });
}
process.stdout.write("ops: " + request.op + "\\n" + JSON.stringify(replies[request.op]) + "\\n");
`;

// A fake pi in RPC mode. It logs its argv, cwd, the HEAD there, pid, whether its session
// file was new, its env's names and its GH_TOKEN to pi.log, then every command it reads, and answers each with
// a response. On "prompt" it plays pi-script.json's events, writing each to
// stdout and the session file as pi does, up to a "wait" mark, where it
// pauses until "abort" (which settles it, aborted) or "steer" (which plays
// the rest). With ignoreAbort it never answers an abort. A rejectPrompt
// script rejects the prompt with that error. On the prompt, a `commit`
// script first commits that file, relative to its cwd, in the repo holding
// it, logging the commit's sha; an `untracked` script leaves that file
// uncommitted. It exits when stdin closes.
const FAKE_PI = `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root = process.env.FAKE_PI_ROOT;
const argv = process.argv.slice(2);
const session = argv[argv.indexOf("--session") + 1];
const fresh = !fs.existsSync(session);
const log = (entry) => fs.appendFileSync(root + "/pi.log", JSON.stringify(entry) + "\\n");
const script = JSON.parse(fs.readFileSync(root + "/pi-script.json", "utf8"));
const git = (dir, args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
let head = null;
try {
  head = git(process.cwd(), ["rev-parse", "HEAD"]);
} catch {}
log({ argv, cwd: process.cwd(), head, pid: process.pid, fresh, env: Object.keys(process.env).sort(), ghToken: process.env.GH_TOKEN ?? null });
const print = (event) => {
  process.stdout.write(JSON.stringify(event) + "\\n");
  fs.appendFileSync(session, JSON.stringify(event) + "\\n");
};
const work = () => {
  if (script.commit) {
    const file = path.join(process.cwd(), script.commit);
    fs.writeFileSync(file, "work\\n");
    git(path.dirname(file), ["add", path.basename(file)]);
    git(path.dirname(file), ["commit", "--quiet", "-m", "work"]);
    log({ committed: git(path.dirname(file), ["rev-parse", "HEAD"]) });
  }
  if (script.untracked) {
    fs.writeFileSync(path.join(process.cwd(), script.untracked), "left\\n");
  }
};
let rest = null;
const play = (events) => {
  const at = events.indexOf("wait");
  if (at < 0) {
    events.forEach(print);
    print({ type: "agent_settled", aborted: false });
    return;
  }
  events.slice(0, at).forEach(print);
  rest = events.slice(at + 1);
};
const respond = (command, fields) =>
  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, ...fields }) + "\\n");
const handle = (command) => {
  log({ command });
  if (command.type === "prompt" && script.rejectPrompt) {
    respond(command, { success: false, error: script.rejectPrompt });
  } else if (command.type === "prompt") {
    respond(command, { success: true, data: { disposition: "started" } });
    work();
    play(script.events);
  } else if (command.type === "abort" && !script.ignoreAbort) {
    respond(command, { success: true });
    if (rest !== null) {
      rest = null;
      print({ type: "agent_settled", aborted: true });
    }
  } else if (command.type === "steer" && rest !== null) {
    respond(command, { success: true });
    const events = rest;
    rest = null;
    play(events);
  } else if (command.type === "steer") {
    respond(command, { success: false, error: "the agent is not running" });
  }
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    handle(JSON.parse(buffer.slice(0, at)));
    buffer = buffer.slice(at + 1);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** @param {object} usage @returns {object} */
function messageEnd(usage) {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], usage, stopReason: "toolUse" },
  };
}

/** @param {boolean} isError @returns {object} */
function toolEnd(isError) {
  return {
    type: "tool_execution_end",
    toolCallId: "t",
    toolName: "bash",
    result: { content: [] },
    isError,
  };
}

/** @param {unknown} details @returns {object} */
function outputEnd(details) {
  return {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "structured_output",
    result: { content: [], details },
    isError: false,
  };
}

export { FAKE_OPS, FAKE_PI, messageEnd, outputEnd, toolEnd };
