// @ts-check
// The full-flow tests' fake `pi --mode rpc`. It runs no model: each prompt
// plays the next scripted turn for the role whose configured model pi was
// started with. It loads the real extensions the job passed with `-e`
// (the built structured-output.mjs and pipeline-commit.mjs) through the
// little of pi's extension API they use, so a turn's commits go through the
// real pipeline_commit tool (which commits in the job's checkouts and asks
// the job over its control socket to push) and its answer through the real
// structured_output tool, whose result the job reads from the
// tool_execution_end event, as it does from pi.
//
// The script, script.json under FLOW_PI_DIR, maps a role to its turns:
//   { files?: { "<path from the job folder>": text }, commits?: string[][],
//     output: object }
// files are written first, then each commits entry is one pipeline_commit
// call's args, then output is the structured answer. A role with no turn
// left answers nothing, so its session fails. Every start, prompt and tool
// result is logged to pi.jsonl under FLOW_PI_DIR.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { fixtureState, versionProbe } from "./runtime-fixtures.mjs";

/**
 * @typedef {object} FlowTurn
 * @property {Record<string, string>} [files]
 * @property {string[][]} [commits]
 * @property {string} [rejectPrompt]
 * @property {Record<string, unknown>} output
 */

/**
 * Where a session's events go: `print` to the job, as pi prints them, and
 * `log` to pi.jsonl for the test.
 * @typedef {{ print: (event: unknown) => void, log: (entry: unknown) => void }} Printers
 */

/**
 * @typedef {object} FlowTool
 * @property {string} name
 * @property {(id: string, params: unknown) => Promise<{ content?: unknown, details?: unknown }>} execute
 */

/** @param {string} dir @param {unknown} entry */
function logTo(dir, entry) {
  fs.appendFileSync(path.join(dir, "pi.jsonl"), `${JSON.stringify(entry)}\n`);
}

/** @param {readonly string[]} argv @param {string} flag @returns {string[]} */
function valuesOf(argv, flag) {
  return argv.flatMap((arg, at) => {
    if (arg === flag && at + 1 < argv.length) {
      return [String(argv[at + 1])];
    }
    return [];
  });
}

/**
 * The next turn of `role`, counted in counts.json, or null when none is left.
 * @param {string} dir @param {string} role @returns {FlowTurn | null}
 */
function nextTurn(dir, role) {
  const script = JSON.parse(
    fs.readFileSync(path.join(dir, "script.json"), "utf8"),
  );
  const countsFile = path.join(dir, "counts.json");
  /** @type {Record<string, number>} */
  let counts = {};
  if (fs.existsSync(countsFile)) {
    counts = JSON.parse(fs.readFileSync(countsFile, "utf8"));
  }
  const n = counts[role] ?? 0;
  counts[role] = n + 1;
  fs.writeFileSync(countsFile, JSON.stringify(counts));
  return script[role]?.[n] ?? null;
}

/**
 * Loads the -e extensions through a minimal extension API.
 * @param {readonly string[]} argv @returns {Promise<Map<string, FlowTool>>}
 */
async function loadTools(argv) {
  /** @type {Map<string, FlowTool>} */
  const tools = new Map();
  /** @type {(() => void)[]} */
  const starts = [];
  const api = {
    // The extensions' flags are read back from argv by getFlag.
    registerFlag() {
      return true;
    },
    /** @param {string} name */
    getFlag(name) {
      return valuesOf(argv, `--${name}`)[0];
    },
    /** @param {FlowTool} tool */
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    /** @param {string} event @param {() => void} handler */
    on(event, handler) {
      if (event === "session_start") {
        starts.push(handler);
      }
    },
  };
  const files = valuesOf(argv, "-e").filter((file) => {
    if (
      file === "builtin:codemode" ||
      file.endsWith("/fixture-provider/index.ts")
    ) {
      return false;
    }
    return true;
  });
  const extensions = await Promise.all(
    files.map((file) => import(pathToFileURL(file).href)),
  );
  for (const extension of extensions) {
    extension.default(api);
  }
  for (const start of starts) {
    start();
  }
  return tools;
}

/**
 * @param {string} toolName @param {string} id @param {unknown} result @param {boolean} isError
 */
function toolEnd(toolName, id, result, isError) {
  return {
    type: "tool_execution_end",
    toolCallId: id,
    toolName,
    result,
    isError,
  };
}

const MESSAGE_END = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      cost: { input: 0, total: 0 },
    },
    stopReason: "toolUse",
  },
};

/**
 * Runs one scripted pipeline_commit call, printing its tool end.
 * @param {FlowTool | undefined} tool
 * @param {string} id
 * @param {readonly string[]} args
 * @param {Printers} out
 */
async function commitOnce(tool, id, args, { print, log }) {
  if (tool === undefined) {
    log({ commitError: "no pipeline_commit tool" });
    print(toolEnd("pipeline_commit", id, { content: [] }, true));
    return;
  }
  try {
    const result = await tool.execute(id, { args });
    log({ committed: result.details });
    print(toolEnd("pipeline_commit", id, result, false));
  } catch (error) {
    const text = String(error);
    log({ commitError: text });
    const result = { content: [{ type: "text", text }] };
    print(toolEnd("pipeline_commit", id, result, true));
  }
}

/**
 * Runs each scripted pipeline_commit call in turn, as a model would.
 * @param {FlowTool | undefined} tool
 * @param {readonly string[][]} commits
 * @param {Printers} out
 * @param {number} [done] how many have run
 * @returns {Promise<void>}
 */
async function commitAll(tool, commits, out, done = 0) {
  const args = commits[done];
  if (args === undefined) {
    return;
  }
  await commitOnce(tool, `c${done + 1}`, args, out);
  await commitAll(tool, commits, out, done + 1);
}

/**
 * Plays `turn` in the job folder, printing each event.
 * @param {FlowTurn} turn
 * @param {Map<string, FlowTool>} tools
 * @param {Printers} out
 */
async function play(turn, tools, out) {
  const { print, log } = out;
  for (const [file, text] of Object.entries(turn.files ?? {})) {
    const where = path.join(process.cwd(), file);
    fs.mkdirSync(path.dirname(where), { recursive: true });
    fs.writeFileSync(where, text);
  }
  await commitAll(tools.get("pipeline_commit"), turn.commits ?? [], out);
  print(MESSAGE_END);
  const output = tools.get("structured_output");
  if (output === undefined) {
    log({ outputError: "no structured_output tool" });
    return;
  }
  const result = await output.execute("out", turn.output);
  print(toolEnd("structured_output", "out", result, false));
}

/**
 * The session's printers: events to stdout and the session file, log
 * entries, tagged with the role, to pi.jsonl.
 * @param {string} dir @param {string} role @param {string} sessionFile
 * @returns {Printers}
 */
function printersOf(dir, role, sessionFile) {
  return {
    print(event) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      fs.appendFileSync(sessionFile, `${JSON.stringify(event)}\n`);
    },
    log(entry) {
      logTo(dir, { role, ...new Object(entry) });
    },
  };
}

/** @param {{ id?: string, type: string }} command @param {object} fields */
function respond(command, fields) {
  const reply = { id: command.id, type: "response", command: command.type };
  process.stdout.write(`${JSON.stringify({ ...reply, ...fields })}\n`);
}

/**
 * Answers one RPC command: a prompt plays the role's next turn and settles.
 * @param {{ dir: string, role: string, tools: Map<string, FlowTool>, out: Printers, model: string }} session
 * @param {{ id?: string, type: string, message?: string }} command
 */
async function handle({ dir, role, tools, out, model }, command) {
  if (command.type === "get_state") {
    respond(command, { success: true, data: fixtureState(model) });
    return;
  }
  if (command.type !== "prompt") {
    respond(command, { success: command.type === "abort" });
    return;
  }
  const turn = nextTurn(dir, role);
  if (turn?.rejectPrompt !== undefined) {
    out.log({ prompt: command.message ?? "", rejected: true });
    respond(command, { success: false, error: turn.rejectPrompt });
    return;
  }
  respond(command, { success: true, data: { disposition: "started" } });
  out.log({ prompt: command.message ?? "", turn: turn !== null });
  if (turn !== null) {
    await play(turn, tools, out);
  }
  out.print({ type: "agent_settled", aborted: false });
}

/**
 * Calls `onLine` with each line read from stdin, and exits at its end.
 * @param {(line: string) => void} onLine
 */
function readLines(onLine) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

/**
 * The fake pi's entry, given the role each configured model plays.
 * @param {Record<string, string>} roleOfModel
 */
async function runFlowPi(roleOfModel) {
  const {
    FLOW_PI_DIR: dir = "",
    GH_TOKEN: ghToken = null,
    GITHUB_TOKEN: githubToken = null,
    ISSUE_PIPELINE_COMMIT_SCOPE: scope,
  } = process.env;
  const argv = process.argv.slice(2);
  if (versionProbe(argv)) {
    return;
  }
  const model = valuesOf(argv, "--model")[0] ?? "";
  fixtureState(model);
  const role = roleOfModel[model] ?? "unknown";
  const out = printersOf(dir, role, String(valuesOf(argv, "--session")[0]));
  out.log({
    start: true,
    model,
    argv,
    cwd: process.cwd(),
    extensions: valuesOf(argv, "-e").map((file) => path.basename(file)),
    ghToken: ghToken ?? githubToken,
    commitScope: scope !== undefined,
  });
  const session = { dir, role, tools: await loadTools(argv), out, model };
  readLines((line) => {
    handle(session, JSON.parse(line)).catch((/** @type {unknown} */ error) => {
      out.log({ failed: String(error) });
      out.print({ type: "agent_settled", aborted: false });
    });
  });
}

/**
 * Puts the fake pi in `bin`.
 * @param {string} bin @param {Record<string, string>} roleOfModel
 */
function installFlowPi(bin, roleOfModel) {
  const kit = new URL(import.meta.url).pathname;
  const source = `#!/usr/bin/env node\nimport { runFlowPi } from ${JSON.stringify(kit)};\nawait runFlowPi(${JSON.stringify(roleOfModel)});\n`;
  fs.writeFileSync(path.join(bin, "pi"), source, { mode: 0o755 });
}

/** @param {string} dir @returns {any[]} every logged pi entry */
function piLog(dir) {
  const file = path.join(dir, "pi.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export { installFlowPi, piLog, runFlowPi };
