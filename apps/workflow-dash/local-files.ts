import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const credentialRoot = /\/runtime\/home(?:\/|$)|\/runtime\/model-key\.env$/u;

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

type BoundedRead =
  | { state: "read"; text: string }
  | { state: "unavailable"; reason: string };

/**
 * A whole regular file within `cap` bytes, or why it can't be read: a
 * missing, linked, refused, oversized or unreadable file stays
 * distinguishable from an empty one.
 */
async function readWhole(path: string, cap: number): Promise<BoundedRead> {
  let resolved: string;
  try {
    resolved = await safePath(path);
  } catch {
    return { state: "unavailable", reason: "credential path refused" };
  }
  try {
    if (!(await lstat(path)).isFile()) {
      return { state: "unavailable", reason: "not a regular file" };
    }
    const file = await open(resolved, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) {
        return { state: "unavailable", reason: "not a regular file" };
      }
      if (info.size > cap) {
        return {
          state: "unavailable",
          reason: `exceeds the ${cap}-byte read bound`,
        };
      }
      const buffer = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(buffer, 0, info.size, 0);
      return {
        state: "read",
        text: buffer.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "unavailable", reason: "file missing" };
    }
    return { state: "unavailable", reason: "file unreadable" };
  }
}

interface DatedDirectory {
  name: string;
  mtime: number;
}
/**
 * Up to `cap` unlinked subdirectories of `path`, newest modification first,
 * with the number left unread; null when `path` itself can't be listed.
 */
async function newestDirs(
  path: string,
  cap: number,
): Promise<{ entries: DatedDirectory[]; omitted: number } | null> {
  let root: string;
  try {
    root = await safePath(path);
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
    const dated = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: await stat(join(root, name)).then(
          (info) => info.mtimeMs,
          () => 0,
        ),
      })),
    );
    dated.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return {
      entries: dated.slice(0, cap),
      omitted: Math.max(0, dated.length - cap),
    };
  } catch {
    return null;
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

/** The unlinked regular files in `path`; none when it can't be listed. */
async function files(path: string): Promise<string[]> {
  try {
    const entries = await readdir(await safePath(path), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export type { BoundedRead, DatedDirectory };
export { dirs, files, newestDirs, readWhole, safePath };
