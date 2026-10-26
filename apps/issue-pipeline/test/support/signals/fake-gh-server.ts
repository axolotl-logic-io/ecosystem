// The fake GitHub server behind a test machine's `gh`: one process holding
// the world in memory, answering one request at a time and writing the
// world file after each change, so the tests read GitHub's state from that
// file. Run as `node fake-gh-server.ts SOCKET WORLD LOG READY`, it listens
// on the Unix socket SOCKET, writes "ready" (or why it could not listen) to
// the FIFO READY, and exits when its standard input closes, that is with
// the test process that started it.
//
// Requests:
//   POST /gh    a gh call: the body holds X-Gh-Argc NUL-terminated
//               arguments, then the call's standard input; X-Gh-Token is
//               its GH_TOKEN. The answer's body is the call's stdout and
//               X-Gh-Exit is `STATUS:STDERR`, STDERR as `\0ddd` octal
//               escapes of each byte, for printf %b.
//   POST /hold  answers the world and holds every later call until /put.
//   POST /put   replaces the held world with the body's and releases it.
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import { gh } from "./fake-gh.ts";
import type { Reply } from "./fake-gh-call.ts";
import {
  parseWorld,
  readWorld,
  type World,
  writeWorld,
} from "./fake-github-world.ts";

const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const OCTAL = 8;
const OCTAL_DIGITS = 3;
const NUL = 0;

const [socket = "", worldFile = "", logFile = "", ready = ""] =
  process.argv.slice(2);
let world: World = readWorld(worldFile);
// Requests run in arrival order, each after the previous one settles.
let queue: Promise<void> = Promise.resolve();
// Ends the current hold with the world /put sent.
let release: ((next: string) => string | null) | null = null;

function serially(work: () => Promise<void> | void): void {
  queue = queue.then(work).catch((error: unknown) => {
    process.stderr.write(`fake gh server: ${String(error)}\n`);
  });
}

function body(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function commit(next: World): void {
  world = structuredClone(writeWorld(worldFile, next));
}

function escaped(text: string): string {
  return [...Buffer.from(text, "utf8")]
    .map((byte) => `\\0${byte.toString(OCTAL).padStart(OCTAL_DIGITS, "0")}`)
    .join("");
}

function call(request: http.IncomingMessage, raw: Buffer): Reply {
  const { "x-gh-argc": argc = "0", "x-gh-token": token = "" } = request.headers;
  const args: string[] = [];
  let at = 0;
  for (let index = 0; index < Number(argc); index += 1) {
    const end = raw.indexOf(NUL, at);
    args.push(raw.subarray(at, end).toString("utf8"));
    at = end + 1;
  }
  return gh(
    structuredClone(world),
    {
      args,
      log: logFile,
      token: String(token),
      stdin: raw.subarray(at).toString("utf8"),
    },
    commit,
  );
}

function hold(response: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    release = (next: string): string | null => {
      try {
        commit(parseWorld(next));
      } catch (error: unknown) {
        return String(error);
      } finally {
        release = null;
        resolve();
      }
      return null;
    };
    response.end(JSON.stringify(world));
  });
}

async function serve(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const raw = await body(request);
  if (request.url === "/put") {
    const done = release?.(raw.toString("utf8"));
    if (done === undefined) {
      response.writeHead(HTTP_CONFLICT).end("no world is held\n");
    } else if (done === null) {
      response.end();
    } else {
      response.writeHead(HTTP_UNPROCESSABLE).end(`${done}\n`);
    }
    return;
  }
  if (request.url === "/hold") {
    serially(() => hold(response));
    return;
  }
  serially(() => {
    const reply = call(request, raw);
    response.writeHead(HTTP_OK, {
      "x-gh-exit": `${reply.status}:${escaped(reply.stderr)}`,
    });
    response.end(reply.stdout);
  });
}

const server = http.createServer((request, response) => {
  serve(request, response).catch((error: unknown) => {
    process.stderr.write(`fake gh server: ${String(error)}\n`);
    response.destroy();
  });
});
server.on("error", (error) => {
  fs.writeFileSync(ready, `${String(error)}\n`);
  process.exit(1);
});
server.listen(socket, () => {
  fs.writeFileSync(ready, "ready\n");
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
