// Host-owned asset, data and agent locations. Packages and tasks receive resolved
// capabilities instead of reading these process-boundary defaults.

import os from "node:os";
import path from "node:path";
import process from "node:process";

const {
  ISSUE_PIPELINE_ROOT: legacyRoot,
  ECOSYSTEM_INSTALL_ROOT: installRoot,
  ECOSYSTEM_DATA_ROOT: dataRoot,
  PI_CODING_AGENT_DIR: agentDirVariable,
}: NodeJS.ProcessEnv = process.env;
const HOME: string = os.homedir();
const INSTALL_ROOT: string = path.resolve(
  installRoot || legacyRoot || path.join(HOME, ".pi/agent/issue-pipeline"),
);
const ROOT: string = path.resolve(dataRoot || legacyRoot || INSTALL_ROOT);
// pi's own folder, where the root installer puts compatible agent definitions.
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

// A path from a config, with a leading `~/` read as the home directory.
function expand(file: string): string {
  if (file.startsWith(HOME_PREFIX)) {
    return path.join(HOME, file.slice(HOME_PREFIX.length));
  }
  return file;
}

// Text posted to GitHub names local paths by variable, not by this machine's
// layout: explicit install/data variables, then the home directory as ~. Any other
// path into a home, temporary or private folder reads `[local path]`.
function redactLocalPaths(text: string): string {
  return text
    .split(INSTALL_ROOT)
    .join("$ECOSYSTEM_INSTALL_ROOT")
    .split(ROOT)
    .join("$ECOSYSTEM_DATA_ROOT")
    .split(HOME)
    .join("~")
    .replace(MACHINE_PATH, LOCAL_PATH);
}

export { AGENT_DIR, expand, HOME, INSTALL_ROOT, ROOT, redactLocalPaths };
