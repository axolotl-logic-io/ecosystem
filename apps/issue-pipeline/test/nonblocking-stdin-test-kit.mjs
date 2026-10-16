// @ts-check
// An --import preload that makes fd 0 a non-blocking pipe before the main
// module runs, as a parent that already touched stdin leaves it (#263).
// Opening process.stdin on a pipe puts the fd in libuv's non-blocking mode;
// pausing it leaves the data for the main module to read. The ready line on
// stderr tells the test the fd is non-blocking.
import process from "node:process";

process.stdin.pause();
process.stderr.write("nonblocking-stdin-ready\n");
