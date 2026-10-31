// Host-owned asset, data and agent locations. Packages and tasks receive resolved
// capabilities instead of reading these process-boundary settings.

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { OpsError } from "@ecosystem/task-runtime/ops-error";

const {
  ECOSYSTEM_INSTALL_ROOT: installRootVariable = "",
  ECOSYSTEM_DATA_ROOT: dataRootVariable = "",
  PI_CODING_AGENT_DIR: agentDirVariable,
}: NodeJS.ProcessEnv = process.env;
const HOME: string = os.homedir();
// pi's own folder, where the root installer puts the agent definitions.
const AGENT_DIR: string = path.resolve(
  agentDirVariable || path.join(HOME, ".pi/agent"),
);
const HOME_PREFIX = "~/";
// An absolute path into a place that is only this machine's: a user's home,
// a temporary or private system folder, or a mounted volume. It starts at
// the beginning of the text, after a space, quote, bracket, `=`, `:` or a
// `/` (as in `file:///`), so a URL's path after its host is not one.
const MACHINE_PATH =
  /(?<![\w.~-])\/(?:Users|home|root|tmp|private|var\/folders|var\/tmp|Volumes|mnt)(?:\/[^\s"'`<>()[\]{},;]*)?/gu;
const LOCAL_PATH = "[local path]";

function required(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new OpsError(`${name} must name an absolute directory`);
  }
  return path.resolve(value);
}

// The installed programs, prompts and support assets: `ECOSYSTEM_INSTALL_ROOT`.
function installRoot(): string {
  return required("ECOSYSTEM_INSTALL_ROOT", installRootVariable);
}

// The operator-owned writable root for clones, work, runs and the default
// model runtime HOME: `ECOSYSTEM_DATA_ROOT`.
function dataRoot(): string {
  return required("ECOSYSTEM_DATA_ROOT", dataRootVariable);
}

// A path from a config, with a leading `~/` read as the home directory.
function expand(file: string): string {
  if (file.startsWith(HOME_PREFIX)) {
    return path.join(HOME, file.slice(HOME_PREFIX.length));
  }
  return file;
}

// Text posted to GitHub names local paths by variable, not by this machine's
// layout: the install and data roots, then the home directory as ~. Any other
// path into a home, temporary or private folder reads `[local path]`.
function redactLocalPaths(text: string): string {
  return text
    .split(installRoot())
    .join("$ECOSYSTEM_INSTALL_ROOT")
    .split(dataRoot())
    .join("$ECOSYSTEM_DATA_ROOT")
    .split(HOME)
    .join("~")
    .replace(MACHINE_PATH, LOCAL_PATH);
}

export { AGENT_DIR, dataRoot, expand, HOME, installRoot, redactLocalPaths };
