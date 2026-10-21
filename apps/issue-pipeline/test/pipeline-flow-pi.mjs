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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { play } from "./pipeline-flow-turn.mjs";
import { fixtureState, versionProbe } from "./runtime-fixtures.mjs";

/**
 * @typedef {object} FlowTurn
 * @property {Record<string, string>} [files]
 * @property {string[][]} [commits]
 * @property {Record<string, string>} [gitlinks] paths and commit identities to stage in repo/
 * @property {string} [rejectPrompt]
 * @property {{ origin: string, branch: string, before: string, after: string }} [targetAdvance] external actor's target move during this turn
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
    scope: JSON.parse(scope ?? "null"),
    repoHead: execFileSync("git", ["-C", "repo", "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
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
