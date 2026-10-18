// The pi extension that ends a stage job's session on a structured answer.
// `pi -e structured-output.mjs --output-schema <file>` gives the session a
// terminating `structured_output` tool whose parameters are the file's JSON
// Schema; the tool's result `details` are the arguments it was given, which
// the job reads from the session's tool_execution_end event and parses
// with the role's reply schema; nothing else checks a reply.
// Modelled on pi's examples/extensions/structured-output.ts; it declares the
// little of pi's extension API it uses, so the repo needs no pi dependency.

import fs from "node:fs";
import process from "node:process";
import { z } from "zod";

const FLAG = "output-schema";
const SCHEMA = z.record(z.string(), z.unknown());

type Arguments = Record<string, unknown>;

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: Arguments;
  terminate: boolean;
}

interface OutputTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Arguments;
  execute: (toolCallId: string, params: Arguments) => Promise<ToolResult>;
}

// The part of pi's ExtensionAPI this extension uses.
interface ExtensionApi {
  registerFlag: (
    name: string,
    options: { description: string; type: "string" },
  ) => void;
  getFlag: (name: string) => boolean | string | undefined;
  registerTool: (tool: OutputTool) => void;
  on: (event: "session_start", handler: () => void) => unknown;
}

// The JSON Schema in the flag's file, or null when the flag is unset or
// the file isn't a JSON object.
function schemaOf(file: boolean | string | undefined): Arguments | null {
  if (typeof file !== "string" || file === "") {
    return null;
  }
  try {
    const parsed = SCHEMA.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

function outputTool(parameters: Arguments): OutputTool {
  return {
    name: "structured_output",
    label: "Structured Output",
    description:
      "Return your final answer as structured output. Call this once, as your last action.",
    promptSnippet: "End the session with the final structured answer",
    parameters,
    execute: (_toolCallId: string, params: Arguments): Promise<ToolResult> =>
      Promise.resolve({
        content: [{ type: "text", text: "Structured output saved." }],
        details: params,
        terminate: true,
      }),
  };
}

// Registers --output-schema, and once the session starts (when pi has read
// the flags), the structured_output tool for the schema the flag names.
function structuredOutput(pi: ExtensionApi): void {
  pi.registerFlag(FLAG, {
    description: "The JSON Schema file for the structured_output tool",
    type: "string",
  });
  pi.on("session_start", (): void => {
    const schema = schemaOf(pi.getFlag(FLAG));
    if (schema === null) {
      console.error(`structured-output: --${FLAG} names no JSON Schema file`);
      process.exitCode = 1;
      return;
    }
    pi.registerTool(outputTool(schema));
  });
}

export default structuredOutput;
