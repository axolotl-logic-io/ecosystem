// Validate the entire operator-owned fleet before starting a launcher.
import fs from "node:fs";
import path from "node:path";
import { type Checked, checkLauncher } from "@ecosystem/launcher/launcher";
import { untrustedFile } from "@ecosystem/task-runtime/trusted-file";
import { z } from "zod";

const ABSOLUTE = z.string().refine(path.isAbsolute, "must be an absolute path");
const CONFIG = z.strictObject({
  version: z.literal(1),
  buddies: z.array(ABSOLUTE).min(1),
  manifest: ABSOLUTE,
  launcher: ABSOLUTE,
});
interface Fleet {
  manifest: string;
  launcher: string;
  buddies: { file: string; checked: Checked }[];
}

function trusted(file: string): void {
  if (untrustedFile(file) !== null) {
    throw new Error(
      `${file} must be a regular file owned by this user and writable by no one else`,
    );
  }
}

function checkOrchestrator(file: string): Fleet {
  if (!path.isAbsolute(file)) {
    throw new Error("--config must be an absolute path");
  }
  trusted(file);
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const config = CONFIG.parse(raw);
  trusted(config.launcher);
  const files = new Set<string>();
  const names = new Set<string>();
  const accounts = new Set<string>();
  const buddies = config.buddies.map((buddy) => {
    const canonical = fs.realpathSync(buddy);
    if (files.has(canonical)) {
      throw new Error(`duplicate buddy entry: ${buddy}`);
    }
    files.add(canonical);
    const checked = checkLauncher(buddy, config.manifest);
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
  return { manifest: config.manifest, launcher: config.launcher, buddies };
}

export type { Fleet };
export { checkOrchestrator };
