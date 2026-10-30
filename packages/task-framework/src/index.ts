import { z } from "zod";

const invocationSchema = z.strictObject({
  version: z.literal(1),
  task: z.string().min(1),
  execution: z.string().min(1),
  inputs: z.json(),
});
type Invocation = z.infer<typeof invocationSchema>;
interface DomainOutcome<Result> {
  status: "completed" | "needs-input" | "blocked" | "no-change";
  result: Result;
}
type ExecutionResult<Result> =
  | { status: "finished"; outcome: DomainOutcome<Result> }
  | { status: "failed"; error: unknown }
  | { status: "cancelled"; reason: unknown };

interface ExecutionContext {
  execution: string;
  signal: AbortSignal;
  checkCancelled: () => void;
  artifacts: { publish: (name: string, content: string) => Promise<void> };
}
interface TaskDefinition<Inputs, Capabilities, Result> {
  id: string;
  inputs: z.ZodType<Inputs>;
  run: (
    inputs: Inputs,
    capabilities: Capabilities,
    context: ExecutionContext,
  ) => Promise<DomainOutcome<Result>>;
}
interface ExecutionHost<Result> {
  signal: AbortSignal;
  artifacts: ExecutionContext["artifacts"];
  cleanup: () => Promise<void>;
  report: (result: ExecutionResult<Result>) => Promise<void>;
}

// Validation precedes capability provisioning and all execution effects.
function parseInvocation<Inputs>(
  value: unknown,
  task: { id: string; inputs: z.ZodType<Inputs> },
): { invocation: Invocation; inputs: Inputs } {
  const invocation = invocationSchema.parse(value);
  if (invocation.task !== task.id) {
    throw new Error(`Invocation task does not match ${task.id}`);
  }
  return { invocation, inputs: task.inputs.parse(invocation.inputs) };
}

// Cleanup and reporting are host operations and remain available after abort.
// A finalization failure is an execution failure, never a domain outcome.
async function executeTask<Inputs, Capabilities, Result>(
  task: TaskDefinition<Inputs, Capabilities, Result>,
  value: unknown,
  provision: (inputs: Inputs) => Promise<Capabilities>,
  host: ExecutionHost<Result>,
): Promise<ExecutionResult<Result>> {
  let result: ExecutionResult<Result>;
  try {
    const { invocation, inputs } = parseInvocation(value, task);
    host.signal.throwIfAborted();
    const capabilities = await provision(inputs);
    host.signal.throwIfAborted();
    const outcome = await task.run(inputs, capabilities, {
      execution: invocation.execution,
      signal: host.signal,
      checkCancelled: (): void => host.signal.throwIfAborted(),
      artifacts: host.artifacts,
    });
    host.signal.throwIfAborted();
    result = { status: "finished", outcome };
  } catch (error) {
    if (host.signal.aborted) {
      result = { status: "cancelled", reason: host.signal.reason };
    } else {
      result = { status: "failed", error };
    }
  }
  try {
    await host.cleanup();
  } catch (error) {
    result = { status: "failed", error };
  }
  try {
    await host.report(result);
  } catch (error) {
    return { status: "failed", error };
  }
  return result;
}

export type {
  DomainOutcome,
  ExecutionContext,
  ExecutionHost,
  ExecutionResult,
  Invocation,
  TaskDefinition,
};
export { executeTask, parseInvocation };
