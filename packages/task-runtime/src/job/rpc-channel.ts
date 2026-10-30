// Correlates commands with native RPC responses and settles outstanding
// callers when the process ends. Session lifecycle records also close stdin.
import type { Writable } from "node:stream";
import { endsSession, RESPONSE, SETTLED } from "./rpc-protocol.ts";

interface RpcAnswer {
  success: boolean;
  error: string | null;
}

interface Channel {
  send: (command: Record<string, unknown>) => Promise<RpcAnswer>;
  answer: (record: unknown) => void;
  endAll: () => void;
}

const ENDED: RpcAnswer = { success: false, error: "the session has ended" };

function channelOf(stdin: Writable): Channel {
  const pending = new Map<string, (answer: RpcAnswer) => void>();
  let sent = 0;
  return {
    send: (command: Record<string, unknown>): Promise<RpcAnswer> => {
      if (stdin.writableEnded) {
        return Promise.resolve(ENDED);
      }
      sent += 1;
      const id = `c${sent}`;
      return new Promise((answer: (a: RpcAnswer) => void): void => {
        pending.set(id, answer);
        stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      });
    },
    answer: (record: unknown): void => {
      const response = RESPONSE.safeParse(record);
      if (response.success) {
        const { id, success, error } = response.data;
        pending.get(id)?.({ success, error: error ?? null });
        pending.delete(id);
      }
    },
    endAll: (): void => {
      for (const answer of pending.values()) {
        answer(ENDED);
      }
      pending.clear();
    },
  };
}

// Answers the command a record responds to and closes stdin once the run
// has settled or pi refused the prompt. During preflight, only answer is used.
function readRecord(record: unknown, stdin: Writable, channel: Channel): void {
  if (SETTLED.safeParse(record).success) {
    stdin.end();
  }
  const response = RESPONSE.safeParse(record);
  if (response.success && endsSession(response.data.id, record)) {
    stdin.end();
  }
  channel.answer(record);
}

export type { Channel, RpcAnswer };
export { channelOf, readRecord };
