// Where the pipeline and pi's agent folder live on this machine, and how text posted to GitHub names
// it without giving away the machine's layout.

import os from "node:os";
import path from "node:path";
import process from "node:process";

const {
  ISSUE_PIPELINE_ROOT: rootVariable,
  PI_CODING_AGENT_DIR: agentDirVariable,
}: NodeJS.ProcessEnv = process.env;
const HOME: string = os.homedir();
const ROOT: string =
  rootVariable || path.join(HOME, ".pi/agent/issue-pipeline");
// pi's own folder, where install.mjs puts the pipeline's agent definitions.
const AGENT_DIR: string = path.resolve(
  agentDirVariable || path.join(HOME, ".pi/agent"),
);
const HOME_PREFIX = "~/";

// A path from a config, with a leading `~/` read as the home directory.
function expand(file: string): string {
  if (file.startsWith(HOME_PREFIX)) {
    return path.join(HOME, file.slice(HOME_PREFIX.length));
  }
  return file;
}

// Text posted to GitHub names local paths by variable, not by this machine's
// layout: the pipeline root as $ISSUE_PIPELINE_ROOT (default
// ~/.pi/agent/issue-pipeline), then the home directory as ~.
function redactLocalPaths(text: string): string {
  return text.split(ROOT).join("$ISSUE_PIPELINE_ROOT").split(HOME).join("~");
}

export { AGENT_DIR, expand, HOME, ROOT, redactLocalPaths };
