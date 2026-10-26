// A test machine's fake GitHub: the long-lived fake gh server
// (fake-gh-server.ts) over the machine's world file, and a `gh` on the
// machine's PATH that forwards each call to it. That `gh` is a POSIX sh
// script around curl: it sends the call's arguments, its GH_TOKEN and, for
// an `--input` call, its standard input, then writes the answer's stdout
// and stderr and exits with its status, exactly as the fake gh process it
// replaces did. Nothing here decides what GitHub answers.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import process from "node:process";
import { parseWorld, readWorld, type World } from "./fake-github-world.ts";

const SERVER = path.join(import.meta.dirname, "fake-gh-server.ts");
const EXECUTABLE = 0o755;
// How long the server may take to listen before the machine fails.
const START_MS = 30_000;
const URL_BASE = "http://fake-gh";

interface FakeGitHub {
  // The server's Unix socket, for changeWorld.
  socket: string;
  // Changes the world as GitHub or a person would, between calls.
  change: (edit: (world: World) => void) => void;
  stop: () => void;
}

// A shell word holding `text` literally.
function quoted(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function client(socket: string, scratch: string): string {
  return `#!/bin/sh
# gh, answered by the fake gh server on ${socket}.
input=
for arg in "$@"; do
  if [ "$arg" = --input ]; then input=1; fi
done
head=${quoted(scratch)}/gh-head.$$
{
  printf '%s\\0' "$@"
  if [ -n "$input" ]; then cat; fi
} | curl --silent --show-error --unix-socket ${quoted(socket)} \\
  --header "X-Gh-Argc: $#" --header "X-Gh-Token: \${GH_TOKEN-}" \\
  --data-binary @- --dump-header "$head" ${URL_BASE}/gh || {
  rm -f "$head"
  exit 1
}
answer=$(sed -n 's/^x-gh-exit: \\([0-9]*:[0-7\\\\]*\\).*$/\\1/p' "$head")
rm -f "$head"
if [ -z "$answer" ]; then
  echo "fake gh: the server gave no answer" >&2
  exit 1
fi
printf '%b' "\${answer#*:}" >&2
exit "\${answer%%:*}"
`;
}

function curl(socket: string, route: string, input: string): string {
  const sent = spawnSync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--unix-socket",
      socket,
      "--data-binary",
      "@-",
      `${URL_BASE}/${route}`,
    ],
    { encoding: "utf8", input },
  );
  if (sent.status !== 0) {
    throw new Error(
      `fake gh server /${route} failed: ${sent.stdout}${sent.stderr}`,
    );
  }
  return sent.stdout;
}

// Changes the world the server on `socket` holds: no gh call is answered
// between reading it and writing `edit`'s result back.
function changeWorld(socket: string, edit: (world: World) => void): void {
  const held = curl(socket, "hold", "");
  let next: World;
  try {
    next = parseWorld(held);
    edit(next);
  } catch (error: unknown) {
    curl(socket, "put", held);
    throw error;
  }
  curl(socket, "put", JSON.stringify(next));
}

// Starts the fake GitHub over `world` in `root`, logging calls to `log`,
// and puts its `gh` in `bin`. `env` is the server's environment, as the
// machine's processes have it.
function startFakeGitHub(options: {
  root: string;
  bin: string;
  world: string;
  log: string;
  env: NodeJS.ProcessEnv;
}): FakeGitHub {
  const { root, bin, world, log, env } = options;
  readWorld(world);
  const socket = path.join(root, "gh.sock");
  const ready = path.join(root, "gh-ready");
  const made = spawnSync("mkfifo", [ready]);
  if (made.status !== 0) {
    throw new Error(`mkfifo failed: ${String(made.stderr)}`);
  }
  const server = spawn(process.execPath, [SERVER, socket, world, log, ready], {
    env,
    stdio: ["pipe", "inherit", "inherit"],
  });
  server.unref();
  // The open pipe keeps the server alive until this process exits.
  if (server.stdin instanceof Socket) {
    server.stdin.unref();
  }
  const started = spawnSync("cat", [ready], {
    encoding: "utf8",
    timeout: START_MS,
  });
  if (started.stdout !== "ready\n") {
    server.kill("SIGKILL");
    throw new Error(
      `the fake gh server did not start: ${started.stdout}${String(started.error ?? "")}`,
    );
  }
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, client(socket, root));
  fs.chmodSync(gh, EXECUTABLE);
  return {
    socket,
    change: (edit: (world: World) => void): void => changeWorld(socket, edit),
    stop: (): void => {
      server.kill("SIGKILL");
    },
  };
}

export type { FakeGitHub };
export { changeWorld, startFakeGitHub };
