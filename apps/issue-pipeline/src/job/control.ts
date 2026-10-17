// How a running stage job is controlled from outside: its live pi sessions
// by launch key and its live ops children, the local socket that steers the
// sessions (`job.mjs --steer`), takes its writer sessions' push requests
// (`pipeline_commit`) and checks a session's reply before it ends
// (`structured_output`, for a session whose role registered a check), and
// the stop that SIGTERM or SIGINT begins. The stop
// aborts every live session, gives each STOP_GRACE_MS to exit and then kills
// its process group, and sends SIGTERM to the process group of every ops
// child live at that moment, and SIGKILL to one that hasn't exited within
// STOP_GRACE_MS (#371). This module alone listens on the socket and handles
// signals; control-protocol.ts holds its requests and clients.

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { endGroup } from "../process-group.ts";
import type {
  PushReply,
  ReplyCheckReply,
  SteerReply,
} from "./control-protocol.ts";
import { CONTROL_REQUEST } from "./control-protocol.ts";
import type { OpsProcess } from "./ops-process.ts";
import type { ReplyChecks } from "./reply-checks.ts";
import { replyChecksOf } from "./reply-checks.ts";
import type { RpcAnswer, RpcProcess } from "./rpc.ts";
import type { ReplyCheck } from "./run-step.ts";
import type { StopSignal } from "./status.ts";

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
const SIGNALS: readonly StopSignal[] = ["SIGTERM", "SIGINT"];

// Pushes what session `key` committed, and says what it pushed.
type OnPush = (key: string) => PushReply;

// A live pi session of the job's.
interface LiveLaunch extends RpcProcess {
  key: string;
}

// A live launch: a pi session, or an ops child.
type LiveHandle =
  | { kind: "session"; session: LiveLaunch }
  | { kind: "ops"; ops: OpsProcess };

interface Control {
  // The steer socket's path.
  socket: string;
  // Keeps `live` live, a session for steers and the stop, an ops child for
  // the stop, until it exits. A session registered once the stop began is
  // stopped; an ops child is not, since the stop runs its own ops.
  register: (live: LiveHandle) => void;
  // Checks session `key`'s replies with `check` until the returned function
  // is called (reply-checks.ts). A reply of a session with no check passes.
  checkReplies: (key: string, check: ReplyCheck) => () => void;
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

// Ends `ops`'s process group: SIGTERM, then SIGKILL if it hasn't exited
// within the grace.
async function stopOps(ops: OpsProcess): Promise<void> {
  if (ops.pid !== null) {
    await endGroup(ops.pid, ops.exited, STOP_GRACE_MS);
  }
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

// What the control's requests reach: the live sessions, the push and the
// sessions' reply checks.
interface Served {
  launches: ReadonlyMap<string, LiveLaunch>;
  onPush: OnPush;
  checks: ReplyChecks;
}

// The answer to one request line: a steer's, a push's or a reply check's.
async function replyTo(
  text: string,
  served: Served,
): Promise<SteerReply | PushReply | ReplyCheckReply> {
  const { launches, onPush, checks } = served;
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
    case "check-reply":
      return await checks.answer(data.key, data.reply);
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
  stopAll: () => Promise<unknown>;
}

function liveSetOf(): LiveSet {
  const sessions = new Map<string, LiveLaunch>();
  const ops = new Set<OpsProcess>();
  function addSession(launch: LiveLaunch, stopping: boolean): void {
    sessions.set(launch.key, launch);
    if (stopping) {
      stopLaunch(launch).catch(() => null);
    }
    launch.exited
      .then((): boolean => sessions.delete(launch.key))
      .catch(() => null);
  }
  function addOps(child: OpsProcess): void {
    ops.add(child);
    child.exited.then((): boolean => ops.delete(child)).catch(() => null);
  }
  return {
    sessions,
    add: (live: LiveHandle, stopping: boolean): void => {
      switch (live.kind) {
        case "session":
          addSession(live.session, stopping);
          return;
        case "ops":
          addOps(live.ops);
          return;
        default:
          unreachable(live);
      }
    },
    stopAll: (): Promise<unknown> =>
      Promise.all([
        ...[...sessions.values()].map(stopLaunch),
        ...[...ops].map(stopOps),
      ]),
  };
}

// Opens the job's control for its run folder: listens on its socket, after
// removing a stale one, answering push requests through `onPush`, and stops
// the live sessions and ops children on SIGTERM or SIGINT. A second signal
// while stopping changes nothing.
async function openControl(runDir: string, onPush: OnPush): Promise<Control> {
  const socket = socketPathOf(runDir);
  const live = liveSetOf();
  const checks = replyChecksOf();
  let signal: StopSignal | null = null;
  function onSignal(received: StopSignal): void {
    if (signal !== null) {
      return;
    }
    signal = received;
    live.stopAll().catch(() => null);
  }
  for (const name of SIGNALS) {
    process.on(name, onSignal);
  }
  const server = net.createServer((connection: net.Socket): void =>
    serve(connection, { launches: live.sessions, onPush, checks }),
  );
  fs.mkdirSync(path.dirname(socket), { recursive: true });
  fs.rmSync(socket, { force: true });
  await listen(server, socket);
  return {
    socket,
    register: (launch: LiveHandle): void => live.add(launch, signal !== null),
    checkReplies: checks.add,
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

export type { Control, LiveHandle, LiveLaunch, OnPush };
export { openControl, STOP_GRACE_MS, socketPathOf, stopLaunch };
