// The requests a running stage job answers on its control socket, and the
// clients that send them: a steer for one of its live sessions
// (`job.mjs --steer`), and a writer session's push request after
// `pipeline_commit` committed. One JSON line each way per connection. Each
// request names the job's invocation binding (job/invocation.ts), which the
// job checks before acting on it (#168).

import net from "node:net";
import { z } from "zod";
import type { InvocationBinding } from "../coordination.ts";
import { INVOCATION_BINDING } from "../coordination-record-schema.ts";

const STEER_REQUEST = z.object({
  type: z.literal("steer"),
  key: z.string(),
  message: z.string(),
  execution: INVOCATION_BINDING,
});
const PUSH_REQUEST = z.object({
  type: z.literal("push"),
  key: z.string(),
  execution: INVOCATION_BINDING,
});
const CONTROL_REQUEST = z.discriminatedUnion("type", [
  STEER_REQUEST,
  PUSH_REQUEST,
]);
const STEER_REPLY = z.object({ ok: z.boolean(), error: z.string().nullable() });
const PUSHED = z.enum(["code", "none", "deferred"]);
const PUSH_REPLY = z.object({
  pushed: PUSHED,
  pushError: z.string().nullable(),
});

type ControlRequest = z.infer<typeof CONTROL_REQUEST>;
type SteerReply = z.infer<typeof STEER_REPLY>;
type Pushed = z.infer<typeof PUSHED>;
type PushReply = z.infer<typeof PUSH_REPLY>;

// The job's answer to `request` on `socket`, parsed, or why there is none.
function exchange<T>(
  socket: string,
  request: ControlRequest,
  schema: z.ZodType<T>,
): Promise<{ reply: T } | { error: string }> {
  return new Promise((resolve): void => {
    let text = "";
    const connection = net.createConnection(socket);
    connection.setEncoding("utf8");
    connection.on("error", (error: Error): void => {
      resolve({ error: `no running job at ${socket}: ${error.message}` });
    });
    connection.on("data", (chunk: string): void => {
      text += chunk;
    });
    connection.on("end", (): void => {
      let reply: unknown = null;
      try {
        reply = JSON.parse(text);
      } catch {
        resolve({ error: "the job gave no answer" });
        return;
      }
      const parsed = schema.safeParse(reply);
      if (parsed.success) {
        resolve({ reply: parsed.data });
      } else {
        resolve({ error: "the job's answer is malformed" });
      }
    });
    connection.write(`${JSON.stringify(request)}\n`);
  });
}

// Asks the job bound to `execution` listening on `socket` to push what
// session `key` committed. Never rejects: a job that can't be reached pushed
// nothing, and says why.
async function requestPush(
  socket: string,
  key: string,
  execution: InvocationBinding,
): Promise<PushReply> {
  const request: ControlRequest = { type: "push", key, execution };
  const answer = await exchange(socket, request, PUSH_REPLY);
  if ("error" in answer) {
    return { pushed: "none", pushError: answer.error };
  }
  return answer.reply;
}

export type { ControlRequest, Pushed, PushReply, SteerReply };
export { CONTROL_REQUEST, requestPush };
