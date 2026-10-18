// @ts-check
// The stage job tests' fakes: the ops.mjs and RPC `pi` sources that
// job-test-kit.mjs installs, and builders for the records pi prints:
// `turns` gives one assistant message per turn whose usage shows that turn's
// context, so a script's context can rise turn by turn.

// Answers each op from replies.json and logs the request to ops.log. A push
// or exit-push whose reply sets `git` pushes the request's checkout's HEAD to
// the issue's branch on origin first, as the real op would. An op whose
// reply sets `hang` never answers: it starts `sleep 600` in the op's own
// process group, writes the sleep's pid to hang.pid and waits on it.
const FAKE_OPS = `import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
const dir = import.meta.dirname;
const input = fs.readFileSync(0, "utf8");
const request = JSON.parse(input.split("BEGIN_OPS_REQUEST")[1].split("END_OPS_REQUEST")[0]);
fs.appendFileSync(dir + "/ops.log", JSON.stringify(request) + "\\n");
const replies = JSON.parse(fs.readFileSync(dir + "/replies.json", "utf8"));
if (replies[request.op]?.hang) {
  const sleep = spawn("sleep", ["600"], { stdio: "ignore" });
  fs.writeFileSync(dir + "/hang.pid", sleep.pid + "\\n");
} else {
  if ((request.op === "push" || request.op === "exit-push") && replies[request.op]?.git) {
    execFileSync("git", ["-C", request.checkout.dir, "push", "--quiet", "origin", "HEAD:refs/heads/agent/issue-7"], {
      env: { ...process.env, ISSUE_PIPELINE_OPS: "1" },
    });
  }
  process.stdout.write("ops: " + request.op + "\\n" + JSON.stringify(replies[request.op]) + "\\n");
}
`;

// A fake pi in RPC mode. It logs its argv, cwd, the HEAD of the code
// checkout there (repo/ when the cwd holds one, as a stage job's folder
// does, else the cwd itself), pid, whether its session
// file was new, its env's names, its GH_TOKEN and its parsed
// ISSUE_PIPELINE_COMMIT_SCOPE (null when unset) to pi.log, then every command it reads, and answers each with
// a response. On "prompt" it plays pi-script.json's events, writing each to
// stdout and the session file as pi does, up to a "wait" mark, where it
// pauses until "abort" (which settles it, aborted) or "steer" (which plays
// the rest). A script with `launches`, a list of event lists, plays
// launches[n] on the n-th prompt across every pi process, counted in
// prompts.count under FAKE_PI_ROOT, its last entry repeating once the list
// runs out. With ignoreAbort it never answers an abort. A `child` script
// starts `sleep 600` in pi's own process group on the prompt and writes its
// pid to pi-child.pid under FAKE_PI_ROOT, as a tool pi runs would. A rejectPrompt
// script rejects the prompt with that error. On the prompt, a `commit`
// script first commits that file, relative to its cwd, in the repo holding
// it, logging the commit's sha; an `untracked` script leaves that file
// uncommitted; a `handoff` script, `{ file, text }`, writes `text` to that
// file, as a session writes its handoff. A script with `sessions`, a map
// from a launch's name (its session file's name less `i<n>-` and `-<seq>`,
// such as review-tests) to an event list, plays that list for that launch,
// whatever the order the launches start in (#421). Its list may hold two
// pseudo-events, played in order and never printed: `{ fakeMark: label }`
// logs `{ mark: label }` to pi.log and leaves the mark under FAKE_PI_ROOT's
// marks/, and `{ fakeHold: label }` waits until that mark is there. It
// exits when stdin closes.
const FAKE_PI = `#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const root = process.env.FAKE_PI_ROOT;
const argv = process.argv.slice(2);
const session = argv[argv.indexOf("--session") + 1];
const fresh = !fs.existsSync(session);
const log = (entry) => fs.appendFileSync(root + "/pi.log", JSON.stringify(entry) + "\\n");
const script = JSON.parse(fs.readFileSync(root + "/pi-script.json", "utf8"));
// It stands in for pipeline_commit, so its commits pass the checkout's pre-commit hook.
const git = (dir, args) => execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: { ...process.env, ISSUE_PIPELINE_COMMIT: "1" } }).trim();
let head = null;
const code = fs.existsSync(path.join(process.cwd(), "repo")) ? path.join(process.cwd(), "repo") : process.cwd();
try {
  head = git(code, ["rev-parse", "HEAD"]);
} catch {}
const scope = process.env.ISSUE_PIPELINE_COMMIT_SCOPE;
const commitScope = scope === undefined ? null : JSON.parse(scope);
log({ argv, cwd: process.cwd(), head, pid: process.pid, fresh, env: Object.keys(process.env).sort(), ghToken: process.env.GH_TOKEN ?? null, commitScope });
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
  if (script.handoff) {
    fs.mkdirSync(path.dirname(script.handoff.file), { recursive: true });
    fs.writeFileSync(script.handoff.file, script.handoff.text);
  }
  if (script.child) {
    const sleep = spawn("sleep", ["600"], { stdio: "ignore" });
    fs.writeFileSync(root + "/pi-child.pid", sleep.pid + "\\n");
  }
};
const promptEvents = () => {
  if (!script.launches) {
    return script.events;
  }
  const counter = root + "/prompts.count";
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  return script.launches[Math.min(n, script.launches.length - 1)];
};
const named = /^i\\d+-(.+)-\\d+\\.jsonl$/u.exec(path.basename(session))?.[1];
const marks = path.join(root, "marks");
const held = (label) => new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(marks, label))) {
      clearInterval(timer);
      resolve();
    }
  }, 20);
});
const playNamed = async (events) => {
  for (const event of events) {
    if (event.fakeMark !== undefined) {
      log({ mark: event.fakeMark, name: named });
      fs.mkdirSync(marks, { recursive: true });
      fs.writeFileSync(path.join(marks, event.fakeMark), "");
    } else if (event.fakeHold !== undefined) {
      await held(event.fakeHold);
    } else {
      print(event);
    }
  }
  print({ type: "agent_settled", aborted: false });
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
  log({ command, name: named });
  if (command.type === "prompt" && script.rejectPrompt) {
    respond(command, { success: false, error: script.rejectPrompt });
  } else if (command.type === "prompt") {
    respond(command, { success: true, data: { disposition: "started" } });
    work();
    if (script.sessions?.[named] !== undefined) {
      playNamed(script.sessions[named]);
    } else {
      play(promptEvents());
    }
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

/**
 * An assistant message's end that spent `usage`, a usage as the job keeps
 * it, printed as pi prints it: its cost a breakdown with its total.
 * @param {import("../src/job/token-usage.ts").Usage} usage
 * @returns {object}
 */
function messageEnd(usage) {
  const { cost, ...counts } = usage;
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      usage: { ...counts, cost: { input: 0, total: cost } },
      stopReason: "toolUse",
    },
  };
}

// The output tokens each turn of `turns` adds, which count towards no
// turn's context.
const TURN_OUTPUT = 5000;
// The share of a turn's context that `turns` gives each of input and cache
// writes; cache reads take the rest.
const TURN_SHARE = 4;

/**
 * One assistant message per entry of `contexts`, whose usage shows that
 * entry as its turn's context, split across input, cache reads and cache
 * writes, with TURN_OUTPUT output tokens besides.
 * @param {readonly number[]} contexts
 * @returns {object[]}
 */
function turns(contexts) {
  return contexts.map((context) => {
    const input = Math.floor(context / TURN_SHARE);
    const cacheWrite = Math.floor(context / TURN_SHARE);
    const cacheRead = context - input - cacheWrite;
    return messageEnd({
      input,
      output: TURN_OUTPUT,
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      cost: 0,
    });
  });
}

/**
 * A call of tool `toolName` ending, failed with `error` as its text when
 * `isError`.
 * @param {boolean} isError @param {string} [toolName] @param {string} [error]
 * @returns {object}
 */
function toolEnd(isError, toolName = "bash", error = "") {
  return {
    type: "tool_execution_end",
    toolCallId: "t",
    toolName,
    result: { content: [{ type: "text", text: error }] },
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

export {
  FAKE_OPS,
  FAKE_PI,
  messageEnd,
  outputEnd,
  TURN_OUTPUT,
  toolEnd,
  turns,
};
