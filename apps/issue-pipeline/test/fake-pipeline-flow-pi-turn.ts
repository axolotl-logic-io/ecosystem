// Execute scripted model edits through the real commit and reply tools. A
// turn with a `barrier` first marks `<name>.reached` in its folder, then
// waits for the test to create `<name>.open` (#133).

import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { humanComment } from "./fake-pipeline-flow-gh.ts";
import { gitIn } from "./fake-pipeline-flow-gh-world.ts";
import type { FlowTool, FlowTurn, Printers } from "./fake-pipeline-flow-pi.ts";
import { writeTurnFiles } from "./pipeline-flow-pi-files-test-kit.ts";

function toolEnd(
  toolName: string,
  id: string,
  result: unknown,
  isError: boolean,
): {
  type: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
} {
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

// Runs one scripted pipeline_commit call, printing its tool end.
async function commitOnce(
  tool: FlowTool | undefined,
  id: string,
  args: readonly string[],
  { print, log }: Printers,
): Promise<void> {
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

// Runs each scripted pipeline_commit call in turn, as a model would.
// done: how many have run
async function commitAll(
  tool: FlowTool | undefined,
  commits: readonly string[][],
  out: Printers,
  done = 0,
): Promise<void> {
  const args = commits[done];
  if (args === undefined) {
    return;
  }
  await commitOnce(tool, `c${done + 1}`, args, out);
  await commitAll(tool, commits, out, done + 1);
}

const BARRIER_POLL_MS = 20;
const BARRIER_MS = 120_000;

// Waits at `barrier` until the test opens it, or fails past its bound.
async function atBarrier(
  { dir, name }: { dir: string; name: string },
  deadline: number = Date.now() + BARRIER_MS,
): Promise<void> {
  fs.writeFileSync(path.join(dir, `${name}.reached`), "");
  if (fs.existsSync(path.join(dir, `${name}.open`))) {
    return;
  }
  if (Date.now() > deadline) {
    throw new Error(`fake pi: barrier ${name} never opened`);
  }
  await delay(BARRIER_POLL_MS);
  await atBarrier({ dir, name }, deadline);
}

// Plays `turn` in the job folder, printing each event.
async function play(
  turn: FlowTurn,
  tools: Map<string, FlowTool>,
  out: Printers,
): Promise<void> {
  const { print, log } = out;
  if (turn.barrier !== undefined) {
    await atBarrier(turn.barrier);
  }
  if (turn.targetAdvance !== undefined) {
    const { origin, branch, before, after } = turn.targetAdvance;
    gitIn(origin, ["update-ref", `refs/heads/${branch}`, after, before]);
  }
  const comment = turn.humanComment;
  if (comment !== undefined) {
    humanComment(comment.dir, comment.issue, comment.login, comment.body);
  }
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
