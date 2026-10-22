import { open, readdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

const credentialRoot = /\/runtime\/home(?:\/|$)|\/runtime\/model-key\.env$/u;
const defaultReadBytes = 262_144;
const sourceReadBytes = 1_048_576;

/** Refuse credential paths after resolving symlinks as well as before opening. */
async function safePath(path: string): Promise<string> {
  const resolved = await realpath(path).catch(() => resolve(path));
  if (
    resolved.split("/").some((part) => part.startsWith(".env")) ||
    credentialRoot.test(resolved)
  ) {
    throw new Error("Credential path refused");
  }
  return resolved;
}

/** Bounded UTF-8 data; a refused/unavailable file contributes no readable text. */
async function readCap(
  path: string,
  cap = defaultReadBytes,
  tail = false,
): Promise<string> {
  try {
    const file = await open(await safePath(path), "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        return "";
      }
      const size = Math.min(info.size, cap);
      const buffer = Buffer.alloc(size);
      let offset = 0;
      if (tail) {
        offset = Math.max(0, info.size - size);
      }
      const { bytesRead } = await file.read(buffer, 0, size, offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      if (tail && info.size > cap) {
        return text.slice(text.indexOf("\n") + 1);
      }
      return text;
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

async function dirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(await safePath(path), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function files(path: string): Promise<string[]> {
  try {
    return await readdir(await safePath(path));
  } catch {
    return [];
  }
}

export { dirs, files, readCap, safePath, sourceReadBytes };
