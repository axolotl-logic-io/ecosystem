// Native RPC JSON framing and lifecycle response grammar. No process or
// transport state: malformed/non-JSON stdout stays an unknown record.
import { z } from "zod";
import type { NativePolicy } from "./runtime-policy.ts";
import { stateRefusal } from "./runtime-policy.ts";

const PROBE_ID = "runtime-policy";
const PROBE_RECORD = z.union([
  z.object({ id: z.literal(PROBE_ID) }),
  z.object({ command: z.literal("get_state") }),
]);
const PROBE_RESPONSE = z.object({
  type: z.literal("response"),
  id: z.literal(PROBE_ID),
  command: z.literal("get_state"),
  success: z.literal(true),
  data: z.unknown(),
});
const FAILED_PROBE = "runtime: native RPC preflight failed";

const PROMPT_ID = "prompt";
const TRAILING_CR = /\r$/u;
const RESPONSE = z.object({
  type: z.literal("response"),
  id: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});
// A prompt pi handled without starting a run, so no agent_settled follows.
const HANDLED = z.object({
  data: z.object({ disposition: z.literal("handled") }),
});
const SETTLED = z.object({ type: z.literal("agent_settled") });

function recordOf(line: string): unknown {
  try {
    const record: unknown = JSON.parse(line.replace(TRAILING_CR, ""));
    return record;
  } catch {
    return null;
  }
}

// Whether `record`, which answered command `id`, ends the session.
function endsSession(id: string, record: unknown): boolean {
  const response = RESPONSE.safeParse(record);
  return (
    id === PROMPT_ID &&
    response.success &&
    (!response.data.success || HANDLED.safeParse(record).success)
  );
}

// Splits stdout's chunks into lines on LF only, as pi's RPC framing says,
// and hands each line to `onLine`; `flush` hands over an unterminated last.
function framerOf(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push: (chunk: string): void => {
      const lines = `${buffer}${chunk}`.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(onLine);
    },
    flush: (): void => {
      if (buffer !== "") {
        onLine(buffer);
      }
      buffer = "";
    },
  };
}

function isProbeRecord(record: unknown): boolean {
  return PROBE_RECORD.safeParse(record).success;
}

function probeRefusal(
  record: unknown,
  preflight: { policy: NativePolicy; endpoint: string } | undefined,
): ReturnType<typeof stateRefusal> | typeof FAILED_PROBE {
  const parsed = PROBE_RESPONSE.safeParse(record);
  if (!parsed.success || preflight === undefined) {
    return FAILED_PROBE;
  }
  return stateRefusal(parsed.data.data, preflight.policy, preflight.endpoint);
}

export {
  endsSession,
  framerOf,
  isProbeRecord,
  probeRefusal,
  RESPONSE,
  recordOf,
  SETTLED,
};
