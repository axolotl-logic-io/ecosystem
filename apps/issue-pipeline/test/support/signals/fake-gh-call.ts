// One fake gh call as a process would see it: its token, its standard
// input and the origin it reads, and the stdout, stderr and exit status it
// leaves. The fake's answers print, fail and exit through these functions,
// which `answer` turns into a Reply instead of ending the process, so one
// long-lived server answers every call exactly as a fresh gh process did.
import process from "node:process";

interface Call {
  token: string;
  stdin: string;
}

interface Reply {
  stdout: string;
  stderr: string;
  status: number;
}

// Thrown to end the current call, as process.exit ended a gh process.
class Exited extends Error {}

let current: { call: Call; reply: Reply } | null = null;

function active(): { call: Call; reply: Reply } {
  if (current === null) {
    throw new Error("fake gh: no call is being answered");
  }
  return current;
}

function print(text: string): void {
  active().reply.stdout += text;
}

function printError(text: string): void {
  active().reply.stderr += text;
}

function setStatus(status: number): void {
  active().reply.status = status;
}

function exit(status: number): never {
  setStatus(status);
  throw new Exited();
}

function fail(message: string): never {
  printError(`${message}\n`);
  return exit(1);
}

function token(): string {
  return active().call.token;
}

function stdin(): string {
  return active().call.stdin;
}

// The real local bare origin that is the repository's git database, from
// the server's environment, or undefined for signal-only fixtures.
function origin(): string | undefined {
  const { FAKE_GH_ORIGIN: dir } = process.env;
  if (dir === undefined || dir === "") {
    return undefined;
  }
  return dir;
}

// Answers `call` with `body`. An error other than an exit ends the call as
// an uncaught one ended a gh process: its stack on stderr, status 1.
function answer(call: Call, body: () => void): Reply {
  const reply: Reply = { stdout: "", stderr: "", status: 0 };
  current = { call, reply };
  try {
    body();
  } catch (error: unknown) {
    if (!(error instanceof Exited)) {
      let text = String(error);
      if (error instanceof Error && error.stack !== undefined) {
        text = error.stack;
      }
      reply.stderr += `${text}\n`;
      reply.status = 1;
    }
  } finally {
    current = null;
  }
  return reply;
}

export type { Call, Reply };
export {
  answer,
  exit,
  fail,
  origin,
  print,
  printError,
  setStatus,
  stdin,
  token,
};
