"use strict";
// @ts-check
// The test a sandbox fixture repository runs (sandbox.test.ts), as hostile
// repository code would: it prints a marker, then reads everything it can
// reach (its environment, the host files and folders named in probe.json,
// every process's environment under /proc, and the sandbox's own home, /tmp
// and cache) and fails if any canary turns up, if it sees more than its own
// few processes, or if it reaches the fake registry over the network.
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const PROBE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "probe.json"), "utf8"),
);
const MAX_DEPTH = 4;
const MAX_BYTES = 65_536;
const MAX_PROCESSES = 10;
const CONNECT_MS = 2000;
const PID = /^\d+$/u;

/** @param {string} file @returns {string} */
function readable(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** @param {string} dir @param {number} depth @returns {string[]} */
function walk(dir, depth) {
  if (depth > MAX_DEPTH) {
    return [];
  }
  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, name);
    /** @type {fs.Stats | null} */
    let stat = null;
    try {
      stat = fs.lstatSync(file);
    } catch {
      return [];
    }
    if (stat.isDirectory()) {
      return walk(file, depth + 1);
    }
    if (stat.isFile() && stat.size < MAX_BYTES) {
      return [readable(file)];
    }
    return [];
  });
}

function pids() {
  return fs.readdirSync("/proc").filter((name) => PID.test(name));
}

console.log(PROBE.printed);

test("finds no credential", () => {
  const seen = [
    JSON.stringify(process.env),
    ...PROBE.files.map(readable),
    ...PROBE.dirs.flatMap((/** @type {string} */ dir) => walk(dir, 0)),
    ...pids().map((pid) => readable(`/proc/${pid}/environ`)),
    ...["/home", "/tmp", "/cache"].flatMap((dir) => walk(dir, 0)),
  ].join("\n");
  for (const canary of PROBE.canaries) {
    assert.equal(seen.includes(canary), false, canary);
  }
  assert.ok(pids().length < MAX_PROCESSES, `sees ${pids().length} processes`);
});

test("reaches no network", async () => {
  const reached = await new Promise((resolve) => {
    const socket = net.connect(PROBE.port, "127.0.0.1", () => {
      socket.end("GET /probe HTTP/1.0\r\n\r\n");
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    setTimeout(() => resolve(false), CONNECT_MS);
  });
  assert.equal(reached, false);
});
