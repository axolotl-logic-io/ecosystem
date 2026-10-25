// Runs commands for the ops kits: sh() runs a bash command, runOps() sends one
// request to the ops CLI framed as the workflow frames it, bound to an owner
// of its issue as a stage job's is (fake-ownership.ts), and setEnv() sets a
// variable in this process's environment. Environment variables are named by
// strings, so they are kept in a map of names, as src/process.ts takes them.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { bindOpsRequest } from "./fake-ownership.ts";

const OPS: string = new URL("../src/ops.ts", import.meta.url).pathname;

// One ops request: the config file it names, the request's fields, and where
// it runs. `ops` is the CLI (src/ops.ts unless a built one), `root` the
// pipeline root, and `home`, when given, the child's HOME.
interface OpsRun {
  config: string;
  request: object;
  root: string;
  ops?: string;
  home?: string;
  // send the request with no binding added
  unbound?: boolean;
}

// Runs a bash command and returns its trimmed stdout; a failure throws.
function sh(command: string): string {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// Sets one variable in this process's environment, which children inherit.
function setEnv(name: string, value: string): void {
  Object.assign(process.env, Object.fromEntries([[name, value]]));
}

// The ops child's whole environment: the pipeline root, this process's PATH
// and, when given, HOME.
function opsEnv(root: string, home: string | undefined): NodeJS.ProcessEnv {
  const { PATH: searchPath, GIT_ALLOW_PROTOCOL: gitProtocols } = process.env;
  const env: Map<string, string | undefined> = new Map([
    ["ISSUE_PIPELINE_ROOT", root],
    ["PATH", searchPath],
    ["GIT_ALLOW_PROTOCOL", gitProtocols],
  ]);
  if (home !== undefined) {
    env.set("HOME", home);
  }
  return Object.fromEntries(env);
}

// The raw stdout of one ops request; a non-zero exit throws.
function runOps({
  config,
  request,
  root,
  ops = OPS,
  home,
  unbound = false,
}: OpsRun): string {
  let sent = request;
  if (unbound !== true) {
    sent = bindOpsRequest({ config, root, request });
  }
  const body = JSON.stringify({ config, ...sent });
  const input = `Issue pipeline ops request follows.\n\nBEGIN_OPS_REQUEST\n${body}\nEND_OPS_REQUEST`;
  const r = spawnSync(process.execPath, [ops], {
    input,
    encoding: "utf8",
    env: opsEnv(root, home),
  });
  if (r.status !== 0) {
    throw new Error(`ops exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout;
}

export { OPS, runOps, setEnv, sh };
