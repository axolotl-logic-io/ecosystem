// How a running stage job is controlled from outside: its live pi sessions
// by launch key, the local socket that steers them (`job.mjs --steer`) and
// takes its writer sessions' push requests (`pipeline_commit`), and the stop
// that SIGTERM or SIGINT begins, which aborts every live session, gives each
// STOP_GRACE_MS to exit and then kills it. This module alone listens on the
// socket and handles signals; control-protocol.ts holds its requests and
// clients.

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { PushReply, SteerReply } from "./control-protocol.ts";
import { CONTROL_REQUEST } from "./control-protocol.ts";
import type { RpcAnswer, RpcProcess } from "./rpc.ts";
import type { StopSignal } from "./status.ts";

// How long a session has to exit after its abort before it is killed.
const STOP_GRACE_MS = 5000;
// The longest socket path every platform takes: macOS's sun_path is 104
// bytes with its terminating zero, Linux's 108.
const SOCKET_PATH_MAX = 103;
const SOCKET_HASH_LENGTH = 12;
const SIGNALS: readonly StopSignal[] = ["SIGTERM", "SIGINT"];

// Pushes what session `key` committed, and says what it pushed.
type OnPush = (key: string) => PushReply;

// A live pi session of the job's.
interface LiveLaunch extends RpcProcess {
  key: string;
}

interface Control {
  // The steer socket's path.
  socket: string;
  // Keeps `launch` live, for steers and the stop, until it exits. A launch
  // registered once the stop began is stopped.
  register: (launch: LiveLaunch) => void;
  // The signal that began the stop, or null while the job runs on.
  stopping: () => StopSignal | null;
  // Stops listening, removes the socket and the signal handlers.
  close: () => void;
}

// Where the job in `runDir` listens: `job.sock` there, or a hashed name in
// the temp folder when that path is too long for a socket.
function socketPathOf(runDir: string): string {
  const beside = path.join(runDir, "job.sock");
  if (Buffer.byteLength(beside) <= SOCKET_PATH_MAX) {
    return beside;
  }
  const hash = createHash("sha256").update(runDir).digest("hex");
  const name = `issue-pipeline-${hash.slice(0, SOCKET_HASH_LENGTH)}.sock`;
  return path.join(os.tmpdir(), name);
}

// Aborts `launch`, and kills it if it hasn't exited within the grace.
async function stopLaunch(launch: LiveLaunch): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const graceUp = new Promise<boolean>((up: (exited: boolean) => void) => {
    timer = setTimeout((): void => up(false), STOP_GRACE_MS);
  });
  const exited = launch.exited.then((): boolean => true);
  const answered = launch.send({ type: "abort" });
  if (!(await Promise.race([exited, graceUp]))) {
    launch.kill("SIGKILL");
  }
  clearTimeout(timer);
  await Promise.all([answered, launch.exited]);
}

async function steerReply(
  launches: ReadonlyMap<string, LiveLaunch>,
  key: string,
  message: string,
): Promise<SteerReply> {
  const launch = launches.get(key);
  if (launch === undefined) {
    return { ok: false, error: `${key} is not a live session of this job` };
  }
  const answer: RpcAnswer = await launch.send({ type: "steer", message });
  return { ok: answer.success, error: answer.error };
}

// The answer to one request line: a steer's or a push's reply.
async function replyTo(
  text: string,
  launches: ReadonlyMap<string, LiveLaunch>,
  onPush: OnPush,
): Promise<SteerReply | PushReply> {
  let request: unknown = null;
  try {
    request = JSON.parse(text);
  } catch {
    return { ok: false, error: "the request is not JSON" };
  }
  const parsed = CONTROL_REQUEST.safeParse(request);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  const { data } = parsed;
  switch (data.type) {
    case "steer":
      return await steerReply(launches, data.key, data.message);
    case "push":
      return onPush(data.key);
    default:
      return unreachable(data);
  }
}

function unreachable(value: never): never {
  throw new Error(`job: unexpected request ${JSON.stringify(value)}`);
}

// Reads one request line from `connection` and answers it. A push is
// answered synchronously, so the job handles push requests one at a time.
function serve(
  connection: net.Socket,
  launches: ReadonlyMap<string, LiveLaunch>,
  onPush: OnPush,
): void {
  let text = "";
  connection.setEncoding("utf8");
  connection.on("error", (): void => {
    connection.destroy();
  });
  connection.on("data", async (chunk: string): Promise<void> => {
    text += chunk;
    if (!text.includes("\n")) {
      return;
    }
    const line = text.split("\n")[0] ?? "";
    text = "";
    const reply = await replyTo(line, launches, onPush);
    connection.end(`${JSON.stringify(reply)}\n`);
  });
}

function listen(server: net.Server, socket: string): Promise<void> {
  return new Promise((resolve: () => void, reject: (e: Error) => void) => {
    server.once("error", reject);
    server.listen(socket, (): void => {
      server.off("error", reject);
      resolve();
    });
  });
}

// Opens the job's control for its run folder: listens on its socket, after
// removing a stale one, answering push requests through `onPush`, and stops
// the live sessions on SIGTERM or SIGINT. A second signal while stopping
// changes nothing.
async function openControl(runDir: string, onPush: OnPush): Promise<Control> {
  const socket = socketPathOf(runDir);
  const launches = new Map<string, LiveLaunch>();
  let signal: StopSignal | null = null;
  function onSignal(received: StopSignal): void {
    if (signal !== null) {
      return;
    }
    signal = received;
    Promise.all([...launches.values()].map(stopLaunch)).catch(() => null);
  }
  for (const name of SIGNALS) {
    process.on(name, onSignal);
  }
  const server = net.createServer((connection: net.Socket): void =>
    serve(connection, launches, onPush),
  );
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.rmSync(socket, { force: true });
  await listen(server, socket);
  return {
    socket,
    register: (launch: LiveLaunch): void => {
      launches.set(launch.key, launch);
      if (signal !== null) {
        stopLaunch(launch).catch(() => null);
      }
      launch.exited
        .then((): boolean => launches.delete(launch.key))
        .catch(() => null);
    },
    stopping: (): StopSignal | null => signal,
    close: (): void => {
      for (const name of SIGNALS) {
        process.off(name, onSignal);
      }
      server.close();
      fs.rmSync(socket, { force: true });
    },
  };
}

export type { Control, LiveLaunch, OnPush };
export { openControl, socketPathOf, stopLaunch };
