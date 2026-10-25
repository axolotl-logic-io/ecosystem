// The sandbox a standards assessment runs repository commands in (#129): one
// bubblewrap (bwrap) container per command, holding no credential. It sees
// read-only system software (/usr without /usr/local, and the few /etc files
// name resolution and TLS need), read-only Node and npm, the exported source
// commit and a package cache, and nothing else of the host: an empty home, a
// private /tmp, its own PID namespace (so no other process's environment
// under /proc), an empty environment (bwrap itself starts with none) and a
// new session. A command runs with
// the host network only when `network` is set, which the caller keeps for
// npm's own fetches; repository code always runs with no network at all.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { run } from "../process.ts";

const BWRAP = "bwrap";
// bwrap's own processes keep the environment they started with, and the
// sandbox's PID 1 is one of them, readable at /proc/1/environ inside. So
// bwrap starts through `env -i`, with nothing of this process's environment.
const CLEAN_START: readonly string[] = ["-i", "PATH=/usr/bin:/bin", BWRAP];
const MAX_LOG_BYTES = 1_048_576;
const TMP_SIZE_BYTES = 1_073_741_824;
const HOME_SIZE_BYTES = 67_108_864;
const PROBE_MS = 30_000;
const MAX_REASON_CHARS = 300;
// Where things appear inside the sandbox.
const NODE_DIR = "/opt/node";
const NPM_CLI = `${NODE_DIR}/lib/node_modules/npm/bin/npm-cli.js`;
const WORK = "/work";
const CACHE = "/cache";
const HOME = "/home/sandbox";
// Host files name resolution and TLS need, bound read-only when present.
const ETC_FILES = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/ssl",
  "/etc/ca-certificates",
];
const USR_LINKS = ["lib", "lib64", "bin", "sbin"];

interface Sandbox {
  // bwrap's version line.
  version: string;
  node: string;
  npm: string;
  // npm's version, from its package.json.
  npmVersion: string;
}

type Opened =
  | { sandbox: Sandbox; reason: "" }
  | { sandbox: null; reason: string };

interface SandboxRun {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  // What the command printed on stdout, and everything it printed, each at
  // most its last MiB.
  stdout: string;
  output: string;
}

interface RunRequest {
  argv: readonly string[];
  // The exported source, bound read-write at /work.
  work: string;
  // A host folder bound read-write at /cache for npm's cache.
  cache: string;
  network: boolean;
  timeoutMs: number;
  // Variables set inside, beside the sandbox's own.
  env?: ReadonlyMap<string, string>;
}

// npm's package beside the running Node, as nvm and the official builds
// install it, or a distribution's copy.
function npmPackageOf(node: string): string | null {
  const candidates = [
    path.join(path.dirname(path.dirname(node)), "lib", "node_modules", "npm"),
    "/usr/lib/node_modules/npm",
    "/usr/share/nodejs/npm",
  ];
  const found = candidates.find((dir) =>
    fs.existsSync(path.join(dir, "bin", "npm-cli.js")),
  );
  return found ?? null;
}

function npmVersionOf(npm: string): string {
  try {
    const { version } = JSON.parse(
      fs.readFileSync(path.join(npm, "package.json"), "utf8"),
    );
    return String(version);
  } catch {
    return "unknown";
  }
}

function sizedTmpfs(size: number, dir: string): string[] {
  return ["--size", String(size), "--tmpfs", dir];
}

function argsOf(sandbox: Sandbox, request: RunRequest): string[] {
  const network = ["--unshare-net"];
  if (request.network) {
    network.length = 0;
  }
  const env = new Map<string, string>([
    ["HOME", HOME],
    ["PATH", `${NODE_DIR}/bin:/usr/bin:/bin`],
    ["LANG", "C.UTF-8"],
    ["CI", "1"],
    ["npm_config_userconfig", `${HOME}/.npmrc`],
    ["npm_config_globalconfig", `${NODE_DIR}/etc/npmrc`],
    ["npm_config_cache", CACHE],
    ["npm_config_update_notifier", "false"],
    ["npm_config_fund", "false"],
    ...(request.env ?? new Map<string, string>()),
  ]);
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    ...network,
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/usr",
    "/usr",
    ...sizedTmpfs(HOME_SIZE_BYTES, "/usr/local"),
    ...USR_LINKS.flatMap((link) => ["--symlink", `usr/${link}`, `/${link}`]),
    ...ETC_FILES.filter((file) => fs.existsSync(file)).flatMap((file) => [
      "--ro-bind",
      file,
      file,
    ]),
    "--ro-bind",
    sandbox.node,
    `${NODE_DIR}/bin/node`,
    "--ro-bind",
    sandbox.npm,
    `${NODE_DIR}/lib/node_modules/npm`,
    "--bind",
    request.work,
    WORK,
    "--bind",
    request.cache,
    CACHE,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...sizedTmpfs(TMP_SIZE_BYTES, "/tmp"),
    ...sizedTmpfs(HOME_SIZE_BYTES, "/home"),
    "--dir",
    HOME,
    "--chdir",
    WORK,
    ...[...env].flatMap(([name, value]) => ["--setenv", name, value]),
    "--",
    ...request.argv,
  ];
}

function lastBytes(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_LOG_BYTES) {
    return text;
  }
  return bytes.subarray(bytes.length - MAX_LOG_BYTES).toString();
}

// Runs `request` in a fresh sandbox.
function inSandbox(sandbox: Sandbox, request: RunRequest): SandboxRun {
  const started = performance.now();
  const result = run("env", [...CLEAN_START, ...argsOf(sandbox, request)], {
    allowFail: true,
    timeoutMs: request.timeoutMs,
  });
  let exitCode: number | null = result.code;
  if (result.timedOut) {
    exitCode = null;
  }
  return {
    exitCode,
    timedOut: result.timedOut,
    durationMs: Math.round(performance.now() - started),
    stdout: lastBytes(result.stdout),
    output: lastBytes(`${result.stdout}${result.stderr}`),
  };
}

// The sandbox on this host, or the reason there's none: bwrap must be
// installed and able to create the namespaces, with npm beside Node.
function openSandbox(): Opened {
  const node = process.execPath;
  const npm = npmPackageOf(node);
  if (npm === null) {
    return { sandbox: null, reason: `no npm package beside ${node}` };
  }
  const version = run("env", [...CLEAN_START, "--version"], {
    allowFail: true,
  });
  if (version.code !== 0) {
    return {
      sandbox: null,
      reason: "bwrap (bubblewrap) isn't installed on this host",
    };
  }
  const sandbox = {
    version: version.stdout.trim(),
    node,
    npm,
    npmVersion: npmVersionOf(npm),
  };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-probe-"));
  try {
    const probe = inSandbox(sandbox, {
      argv: [`${NODE_DIR}/bin/node`, "-e", "process.exit(0)"],
      work,
      cache: work,
      network: false,
      timeoutMs: PROBE_MS,
    });
    if (probe.exitCode !== 0) {
      const said = probe.output.trim().slice(0, MAX_REASON_CHARS);
      return {
        sandbox: null,
        reason: `bwrap couldn't start a sandbox: ${said}`,
      };
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return { sandbox, reason: "" };
}

export type { Sandbox, SandboxRun };
export { inSandbox, NODE_DIR, NPM_CLI, openSandbox };
