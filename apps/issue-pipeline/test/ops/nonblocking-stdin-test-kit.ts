// Non-blocking fd 0; signal only when the real stdin consumer attempts a read.
import fs from "node:fs";
import process from "node:process";

process.stdin.pause();
const read: (size: number) => void = process.stdin._read;
let first = true;
process.stdin._read = (size: number): void => {
  if (first) {
    first = false;
    try {
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      throw new Error("stdin was not an empty non-blocking pipe");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error) ||
        error.code !== "EAGAIN"
      ) {
        throw error;
      }
    }
    process.stdin.once("data", () =>
      process.stderr.write("stdin-chunk-read\n"),
    );
    process.stderr.write("nonblocking-stdin-ready\n");
  }
  read.call(process.stdin, size);
};
