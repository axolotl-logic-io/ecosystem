// Where the installed release lives, read once at a process boundary. Library
// functions take the resolved root instead of reading the environment.
import path from "node:path";

// The absolute install root that `env` names in `ECOSYSTEM_INSTALL_ROOT`.
// Throws when the variable is unset or not absolute.
function installRootOf(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const { ECOSYSTEM_INSTALL_ROOT: installRoot = "" } = env;
  if (!path.isAbsolute(installRoot)) {
    throw new Error("ECOSYSTEM_INSTALL_ROOT must name an absolute directory");
  }
  return path.resolve(installRoot);
}

export { installRootOf };
