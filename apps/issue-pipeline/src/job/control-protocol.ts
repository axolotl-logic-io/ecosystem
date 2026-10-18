// The requests a running stage job answers on its control socket, and the
// clients that send them: a steer for one of its live sessions
// (`job.mjs --steer`), and a writer session's push request after
// `pipeline_commit` committed. One JSON line each way per connection.

import net from "node:net";
import { z } from "zod";

const STEER_REQUEST = z.object({
  type: z.literal("steer"),
  key: z.string(),
  message: z.string(),
});
const PUSH_REQUEST = z.object({ type: z.literal("push"), key: z.string() });
const CONTROL_REQUEST = z.discriminatedUnion("type", [
  STEER_REQUEST,
  PUSH_REQUEST,
]);
const STEER_REPLY = z.object({ ok: z.boolean(), error: z.string().nullable() });
const PUSHED = z.enum(["both", "code", "wiki", "none", "deferred"]);
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

// Sends `message` to session `key` of the job listening on `socket`, and
// resolves to null once pi accepted it, or else to the reason it didn't.
async function steerJob(
  socket: string,
  key: string,
  message: string,
): Promise<string | null> {
  const request: ControlRequest = { type: "steer", key, message };
  const answer = await exchange(socket, request, STEER_REPLY);
  if ("error" in answer) {
    return answer.error;
  }
  if (answer.reply.ok) {
    return null;
  }
  return answer.reply.error ?? "pi rejected the steer";
}

// Asks the job listening on `socket` to push what session `key` committed.
// Never rejects: a job that can't be reached pushed nothing, and says why.
async function requestPush(socket: string, key: string): Promise<PushReply> {
  const answer = await exchange(socket, { type: "push", key }, PUSH_REPLY);
  if ("error" in answer) {
    return { pushed: "none", pushError: answer.error };
  }
  return answer.reply;
}

export type { ControlRequest, Pushed, PushReply, SteerReply };
export { CONTROL_REQUEST, requestPush, steerJob };
