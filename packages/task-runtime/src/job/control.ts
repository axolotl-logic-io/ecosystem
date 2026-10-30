// Local model-session socket: steers and authenticated push requests.
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { InvocationBinding } from "../job/session-identity.ts";
import { sameBinding } from "../job/session-identity.ts";
import type { PushReply, SteerReply } from "./control-protocol.ts";
import { CONTROL_REQUEST } from "./control-protocol.ts";
import type { RpcAnswer, RpcProcess } from "./rpc.ts";

// How long a session has to exit after its abort, and an ops child or a
// timed-out launch after its SIGTERM, before its process group is killed. It
// must stay above SHELL_KILL_GRACE_MS (src/shell-protocol.ts), so that the
// shell supervisor of an op stopped mid-command ends the command's group
// before this SIGKILL reaches the supervisor.
const STOP_GRACE_MS = 5000;
// The longest socket path every platform takes: macOS's sun_path is 104
// bytes with its terminating zero, Linux's 108.
const SOCKET_PATH_MAX = 103;
const SOCKET_HASH_LENGTH = 12;

// Pushes what session `key` committed, and says what it pushed.
type OnPush = (key: string) => PushReply;

// A live pi session of the job's.
interface LiveLaunch extends RpcProcess {
  key: string;
}

// A live model session.
interface LiveHandle {
  kind: "session";
  session: LiveLaunch;
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

// Aborts `launch`, and kills its process group if it hasn't exited within
// the grace.
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

// What the control's requests reach: the live sessions and the push, for
// the job's invocation binding.
interface Served {
  launches: ReadonlyMap<string, LiveLaunch>;
  onPush: OnPush;
  binding: InvocationBinding;
}

const PUSH_TYPE = z.looseObject({ type: z.literal("push") });
const NOT_BOUND = "the request doesn't name this job's invocation binding";

// The answer to a request that fails to parse or names another binding: a
// push's refusal for a push, a steer's otherwise.
function refusal(request: unknown, error: string): SteerReply | PushReply {
  if (PUSH_TYPE.safeParse(request).success) {
    return { pushed: "none", pushError: error };
  }
  return { ok: false, error };
}

// The answer to one request line: a steer's or a push's, only for a request
// that names the job's own binding.
async function replyTo(
  text: string,
  served: Served,
): Promise<SteerReply | PushReply> {
  const { launches, onPush } = served;
  let request: unknown = null;
  try {
    request = JSON.parse(text);
  } catch {
    return { ok: false, error: "the request is not JSON" };
  }
  const parsed = CONTROL_REQUEST.safeParse(request);
  if (!parsed.success) {
    return refusal(request, z.prettifyError(parsed.error));
  }
  const { data } = parsed;
  if (!sameBinding(data.execution, served.binding)) {
    return refusal(request, NOT_BOUND);
  }
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
  throw new Error(`job: unexpected ${JSON.stringify(value)}`);
}

// Reads one request line from `connection` and answers it. A push is
// answered synchronously, so the job handles push requests one at a time.
function serve(connection: net.Socket, served: Served): void {
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
    const reply = await replyTo(line, served);
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

// The job's live launches: its sessions by key and its ops children.
interface LiveSet {
  sessions: ReadonlyMap<string, LiveLaunch>;
  // Keeps `live` until it exits, stopping a session at once if `stopping`.
  add: (live: LiveHandle, stopping: boolean) => void;
  // Stops every launch live now.
}

function liveSetOf(): LiveSet {
  const sessions = new Map<string, LiveLaunch>();
  function addSession(launch: LiveLaunch, stopping: boolean): void {
    sessions.set(launch.key, launch);
    if (stopping) {
      stopLaunch(launch).catch(() => null);
    }
    launch.exited
      .then((): boolean => sessions.delete(launch.key))
      .catch(() => null);
  }
  return {
    sessions,
    add: (live: LiveHandle, stopping: boolean): void => {
      addSession(live.session, stopping);
    },
  };
}

// Listens on `socket`, after removing a stale one, answering `served`'s
// requests, and resolves to what closes it.
async function serveSocket(
  socket: string,
  served: Served,
): Promise<() => void> {
  const server = net.createServer((connection: net.Socket): void =>
    serve(connection, served),
  );
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.rmSync(socket, { force: true });
  await listen(server, socket);
  return (): void => {
    server.close();
    fs.rmSync(socket, { force: true });
  };
}

// A control socket with no stop of its own, for a caller that stops its
// launches cooperatively: its path, what keeps a live
// launch steerable until it exits, the live sessions, and what closes it.
// Nothing here signals or kills a launch.
interface ControlSocket {
  socket: string;
  register: (live: LiveHandle) => void;
  sessions: ReadonlyMap<string, LiveLaunch>;
  close: () => void;
}

// Opens a control socket in `dir` that answers the requests naming
// `binding`: steers to its live sessions and push requests through `onPush`.
async function openControlSocket(
  dir: string,
  onPush: OnPush,
  binding: InvocationBinding,
): Promise<ControlSocket> {
  const socket = socketPathOf(dir);
  const live = liveSetOf();
  const close = await serveSocket(socket, {
    launches: live.sessions,
    onPush,
    binding,
  });
  return {
    socket,
    register: (launch: LiveHandle): void => live.add(launch, false),
    sessions: live.sessions,
    close,
  };
}

export type { ControlSocket, LiveHandle, LiveLaunch, OnPush };
export { openControlSocket, STOP_GRACE_MS, socketPathOf, stopLaunch };
