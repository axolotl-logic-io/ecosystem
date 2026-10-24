import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { type Engine, engineOf, save } from "./engine.ts";
import { readText } from "./project.ts";
import { messageOf, OPERATION, REPORT } from "./protocol.ts";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
  terminate?: boolean;
}
interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (id: string, input: unknown) => Promise<ToolResult>;
}
interface ExtensionApi {
  registerTool: (tool: Tool) => void;
  setActiveTools: (names: string[]) => void;
  on: {
    (event: "session_start" | "session_shutdown", handler: () => void): unknown;
    (
      event: "tool_call",
      handler: (event: {
        toolName: string;
      }) => { block: boolean; reason: string } | undefined,
    ): unknown;
  };
}

const TOOLS = ["safe_refactor", "safe_refactor_finish"];
const FINDING = z.looseObject({ id: z.string() });
const MAX_MODEL_OUTPUT = 48_000;

function resultOf(details: unknown): ToolResult {
  let text = JSON.stringify(details);
  if (text.length > MAX_MODEL_OUTPUT) {
    text = `${text.slice(0, MAX_MODEL_OUTPUT)}\nOutput truncated. Inspect smaller source ranges; full check evidence is retained in the run artifacts.`;
  }
  return { content: [{ type: "text", text }], details };
}

function safeRefactor(pi: ExtensionApi): void {
  let engine: Engine | undefined;
  let finished = false;
  let directory = "";
  pi.on("tool_call", (event) => ({
    block: !TOOLS.includes(event.toolName),
    reason: "Safe Refactor permits only its constrained tools",
  }));
  pi.on("session_start", (): void => {
    const { SAFE_REFACTOR_RUN: run } = process.env;
    if (run === undefined || !path.isAbsolute(run)) {
      throw new Error("Safe Refactor requires caller-provided run scope");
    }
    directory = fs.realpathSync(run);
    const assignment: unknown = JSON.parse(
      readText(path.join(directory, "assignment.json")),
    );
    engine = engineOf(assignment, directory);
    pi.registerTool({
      name: "safe_refactor",
      label: "Safe Refactor",
      description:
        "Inspect assigned JS/TS source, run the fixed codebase check, or request a named TypeScript-language-service refactoring. Inspect returns qualified targets, return-expression offsets and a source hash required for mutation. Check returns paginated JSON evidence and a verdict/count summary; use baseline:true to revisit original findings, offset/limit to read later characters and hash to detect changed evidence. Rename supports function-local primitive bindings; extraction supports complete pure return expressions in synchronous named functions. Unsupported cases refuse. No arbitrary source, patch, shell, threshold or configuration arguments are accepted.",
      parameters: z.toJSONSchema(OPERATION, { io: "input" }),
      execute: (_id: string, input: unknown): Promise<ToolResult> => {
        if (finished || engine === undefined) {
          throw new Error("run has no active mutation scope");
        }
        const result = engine.execute(input);
        return Promise.resolve(resultOf(result));
      },
    });
    pi.registerTool({
      name: "safe_refactor_finish",
      label: "Report Safe Refactor",
      description:
        "Report design rationale and a disposition/reason for every baseline metric finding. The caller independently records actual checks and operation checkpoints. This proposal does not establish Hardening, Security or landing authority.",
      parameters: z.toJSONSchema(REPORT, { io: "input" }),
      execute: (_id: string, input: unknown): Promise<ToolResult> => {
        if (finished || engine === undefined) {
          throw new Error("run is already finished or unavailable");
        }
        const report = REPORT.parse(input);
        const findings =
          engine.baseline.checks.find((entry) => entry.name === "metrics")
            ?.diagnostics ?? [];
        const expected = new Set(
          findings.map((entry) => FINDING.parse(entry).id),
        );
        const supplied = new Set(report.findings.map((entry) => entry.id));
        if (
          supplied.size !== report.findings.length ||
          supplied.size !== expected.size ||
          [...expected].some((id) => !supplied.has(id))
        ) {
          throw new Error(
            "report must account for each baseline metric finding exactly once",
          );
        }
        try {
          engine.check();
          save(directory, "proposal.json", report);
        } catch (error: unknown) {
          throw new Error(`cannot finish: ${messageOf(error)}`, {
            cause: error,
          });
        }
        finished = true;
        return Promise.resolve({
          ...resultOf({ reported: true, deliveryAuthority: false }),
          terminate: true,
        });
      },
    });
    pi.setActiveTools(TOOLS);
  });
  pi.on("session_shutdown", (): void => {
    engine?.dispose();
    engine = undefined;
  });
}

export type { ExtensionApi, Tool };
export default safeRefactor;
