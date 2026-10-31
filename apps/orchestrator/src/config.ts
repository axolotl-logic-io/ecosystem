// Validate the entire operator-owned fleet before starting a launcher.
import fs from "node:fs";
import path from "node:path";
import { readBuddyFile } from "@ecosystem/launcher/buddy-file";
import { type Checked, checkLauncher } from "@ecosystem/launcher/launcher";
import { untrustedFile } from "@ecosystem/task-runtime/trusted-file";
import { z } from "zod";

const ABSOLUTE = z.string().refine(path.isAbsolute, "must be an absolute path");
const CONFIG = z.strictObject({
  version: z.literal(1),
  buddies: z.array(ABSOLUTE).min(1),
  launcher: ABSOLUTE,
});
interface Fleet {
  installRoot: string;
  launcher: string;
  hiddenVariables: string[];
  buddies: { file: string; checked: Checked }[];
}

function trusted(file: string): void {
  if (untrustedFile(file) !== null) {
    throw new Error(
      `${file} must be a regular file owned by this user and writable by no one else`,
    );
  }
}

// Validates the fleet at `file` and every buddy against the release at
// `installRoot`, the root each launcher resolves from the same environment.
function checkOrchestrator(file: string, installRoot: string): Fleet {
  if (!path.isAbsolute(file)) {
    throw new Error("--config must be an absolute path");
  }
  trusted(file);
  const config = CONFIG.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  trusted(config.launcher);
  const files = new Set<string>();
  const names = new Set<string>();
  const accounts = new Set<string>();
  const hiddenVariables = new Set<string>();
  const buddies = config.buddies.map((buddy) => {
    const canonical = fs.realpathSync(buddy);
    if (files.has(canonical)) {
      throw new Error(`duplicate buddy entry: ${buddy}`);
    }
    files.add(canonical);
    const checked = checkLauncher(buddy, installRoot);
    hiddenVariables.add(readBuddyFile(buddy).credentials.variable);
    const name = checked.buddy.toLowerCase();
    const account = checked.account.toLowerCase();
    if (names.has(name) || accounts.has(account)) {
      throw new Error(
        `duplicate buddy name or account: ${checked.buddy} @${checked.account}`,
      );
    }
    names.add(name);
    accounts.add(account);
    return { file: path.resolve(buddy), checked };
  });
  return {
    installRoot,
    launcher: config.launcher,
    hiddenVariables: [...hiddenVariables],
    buddies,
  };
}

export type { Fleet };
export { checkOrchestrator };
