// @ts-check
// Execute scripted model edits through the real commit and reply tools.
import { writeTurnFiles } from "./pipeline-flow-pi-files-test-kit.mjs";

/** @import { FlowTool, FlowTurn, Printers } from "./fake-pipeline-flow-pi.mjs" */

/** @param {string} toolName @param {string} id @param {unknown} result @param {boolean} isError */
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
  writeTurnFiles(turn);
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

export { play };
