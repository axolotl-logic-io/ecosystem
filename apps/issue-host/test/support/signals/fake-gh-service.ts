// The shared fake-gh wire protocol: one serial service per test machine,
// with argument/stdin framing, gh exit status and an atomic state-change hold.
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import type { Call, Reply } from "./fake-gh-call.ts";

const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const OCTAL = 8;
const OCTAL_DIGITS = 3;
const NUL = 0;

interface Request extends Call {
  args: string[];
}
interface Service {
  socket: string;
  ready: string;
  call: (request: Request) => Reply;
  read: () => string;
  write: (text: string) => void;
}

function body(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function escaped(text: string): string {
  return [...Buffer.from(text, "utf8")]
    .map((byte) => `\\0${byte.toString(OCTAL).padStart(OCTAL_DIGITS, "0")}`)
    .join("");
}

function framed(request: http.IncomingMessage, raw: Buffer): Request {
  const { "x-gh-argc": argc = "0", "x-gh-token": token = "" } = request.headers;
  const args: string[] = [];
  let at = 0;
  for (let index = 0; index < Number(argc); index += 1) {
    const end = raw.indexOf(NUL, at);
    args.push(raw.subarray(at, end).toString("utf8"));
    at = end + 1;
  }
  return {
    args,
    token: String(token),
    stdin: raw.subarray(at).toString("utf8"),
  };
}

function serveFakeGitHub(service: Service): void {
  let queue: Promise<void> = Promise.resolve();
  let release: ((next: string) => string | null) | null = null;
  function serially(work: () => Promise<void> | void): void {
    queue = queue.then(work).catch((error: unknown) => {
      process.stderr.write(`fake gh server: ${String(error)}\n`);
    });
  }
  function hold(response: http.ServerResponse): Promise<void> {
    return new Promise((resolve) => {
      release = (next: string): string | null => {
        try {
          service.write(next);
        } catch (error: unknown) {
          return String(error);
        } finally {
          release = null;
          resolve();
        }
        return null;
      };
      response.end(service.read());
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
      const reply = service.call(framed(request, raw));
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
    fs.writeFileSync(service.ready, `${String(error)}\n`);
    process.exit(1);
  });
  server.listen(service.socket, () =>
    fs.writeFileSync(service.ready, "ready\n"),
  );
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}

export type { Request };
export { serveFakeGitHub };
