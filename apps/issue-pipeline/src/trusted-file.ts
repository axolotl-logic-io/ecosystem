// Whether a file is the operator's own: a regular file, not a link, that the
// current user owns and nobody else can write.
import fs from "node:fs";
import process from "node:process";

// The group and other write bits.
const GROUP_WRITE = 0o20;
const OTHER_WRITE = 0o2;
const SHARED_WRITE_BITS: readonly number[] = [GROUP_WRITE, OTHER_WRITE];

// Why `file` isn't trusted, or null when it is.
function untrustedFile(file: string): "unreadable" | "shared" | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return "unreadable";
  }
  const uid = process.getuid?.();
  if (
    !stat.isFile() ||
    SHARED_WRITE_BITS.some(
      (bit: number): boolean => Math.floor(stat.mode / bit) % 2 === 1,
    ) ||
    (uid !== undefined && stat.uid !== uid)
  ) {
    return "shared";
  }
  return null;
}

export { untrustedFile };
