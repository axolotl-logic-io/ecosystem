// @ts-check
// A takeover for any fake GitHub that serves the real transport itself,
// such as the full-flow world (#169): a `gh` placed first on PATH passes
// every call to the fake it hides, and once armed, runs a successor just
// after the next comment listing of the armed issue is answered. That
// listing is a bound ops request's ownership check, so the check passes on
// what it read and the request's next fresh read sees the successor. Armed
// `afterWrite`, it waits for the request's first write and takes the issue
// after the listing that follows, which loses ownership just before the
// request's next write instead.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const OWNER = new URL("./fake-ownership-owner.mjs", import.meta.url).pathname;

/** @param {string} bin @param {string} inner @returns {string} */
function shim(bin, inner) {
  return `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const marker = ${JSON.stringify(path.join(bin, "takeover.json"))};
const args = process.argv.slice(2);
const r = spawnSync(${JSON.stringify(inner)}, args, { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", env: process.env });
fs.writeSync(1, r.stdout ?? "");
fs.writeSync(2, r.stderr ?? "");
if (process.env.FAKE_OWNERSHIP_QUIET !== "1" && fs.existsSync(marker)) {
  const frame = JSON.parse(fs.readFileSync(marker, "utf8"));
  const write = args.includes("-X") || args.includes("--method") || args[0] === "pr" && !["list", "view", "checks"].includes(args[1]);
  if (frame.afterWrite && write) {
    frame.afterWrite = false;
    fs.writeFileSync(marker, JSON.stringify(frame));
  } else if (!frame.afterWrite && args.some(arg => arg.endsWith("/issues/" + frame.number + "/comments?per_page=100"))) {
    fs.rmSync(marker);
    const taken = spawnSync(process.execPath, [${JSON.stringify(OWNER)}, "successor"], { input: JSON.stringify(frame), encoding: "utf8", env: { ...process.env, FAKE_OWNERSHIP_QUIET: "1" } });
    if (taken.status !== 0) throw new Error("the successor didn't take the issue: " + taken.stderr);
  }
}
process.exit(r.status ?? 1);
`;
}

/**
 * Arms a takeover of `frame`'s issue from its owner `frame.execution`,
 * hiding `bin`'s gh behind the shim the first time.
 * @param {string} bin
 * @param {{ number: number, execution: object, afterWrite?: boolean }} frame
 * @returns {void}
 */
function armTakeover(bin, frame) {
  const gh = path.join(bin, "gh");
  const inner = path.join(bin, "gh-hidden-by-takeover");
  if (!fs.existsSync(inner)) {
    fs.renameSync(gh, inner);
    fs.writeFileSync(gh, shim(bin, inner), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, "takeover.json"), JSON.stringify(frame));
}

export { armTakeover };
