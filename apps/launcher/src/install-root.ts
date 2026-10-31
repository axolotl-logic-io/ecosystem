// Where the installed release lives, read once at a process boundary. Library
// functions take the resolved root instead of reading the environment.
import os from "node:os";
import path from "node:path";

// The absolute install root that `env` names: `ECOSYSTEM_INSTALL_ROOT`, then
// the historical `ISSUE_PIPELINE_ROOT`, then `~/.pi/agent/issue-pipeline`.
function installRootOf(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const {
    ECOSYSTEM_INSTALL_ROOT: installRoot,
    ISSUE_PIPELINE_ROOT: legacyRoot,
  } = env;
  // An empty variable counts as unset.
  const named = [installRoot, legacyRoot].find(
    (root): root is string => root !== undefined && root !== "",
  );
  return path.resolve(
    named ?? path.join(os.homedir(), ".pi/agent/issue-pipeline"),
  );
}

export { installRootOf };
