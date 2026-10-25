// Barriers in the full-flow fake GitHub (#133, #171): a test arms a gate,
// and the first call whose arguments include every string of the gate's
// `match` is held. By default the world answers it as usual and only its
// reply waits; a `before` gate holds the call before the world sees it, and
// a `drop` gate loses it, write and reply both, with a 502; a `kill` gate
// kills the process that made the call, as if it died there. A held call
// marks the gate reached, then waits outside the world's lock until the
// test opens it, or, for a gate with `requests`, until the world holds that
// many coordination requests for the gate's issue. So a test can stop a
// process just before or after a write lands, with no sleep in the test.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { readWorld } from "./fake-pipeline-flow-gh-world.ts";

const POLL_MS = 10;
const GATE_MS = 60_000;
const SLEEPER = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const REQUEST = /"kind":"request"/u;

interface Gate {
  // the gate's files are `<name>.reached` and `<name>.open`
  name: string;
  // substrings that together select the call
  match: string[];
  // hold the call before the world answers it
  before?: boolean;
  // lose the call: no write, a 502 reply
  drop?: boolean;
  // kill the process that made the call (SIGKILL)
  kill?: boolean;
  // open once the world holds this many coordination requests on the issue
  requests?: { issue: number; count: number };
  // calls the gate holds before it retires, default 1
  uses?: number;
}

function gatesFile(dir: string): string {
  return path.join(dir, "gates.json");
}

function gatesOf(dir: string): Gate[] {
  if (!fs.existsSync(gatesFile(dir))) {
    return [];
  }
  return JSON.parse(fs.readFileSync(gatesFile(dir), "utf8"));
}

// Returns whether a test ever armed a gate here
function hasGates(dir: string): boolean {
  return fs.existsSync(gatesFile(dir));
}

//  Arms `gate` in the fake GitHub in `dir`.
function armGate(dir: string, gate: Gate): void {
  const gates = gatesOf(dir).filter(({ name }) => name !== gate.name);
  fs.writeFileSync(gatesFile(dir), JSON.stringify([...gates, gate]));
}

//  Opens the gate named `name`.
function openGate(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, `${name}.open`), "");
}

// Returns whether a call reached the gate
function gateReached(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, `${name}.reached`));
}

function requestsHeld(
  dir: string,
  { issue, count }: { issue: number; count: number },
): boolean {
  const { comments } = readWorld(dir);
  const held = comments.filter(
    (each) => each.issue === issue && REQUEST.test(each.body),
  );
  return held.length >= count;
}

// Takes the gate the call `args` selects at this point, `before` the world
// answers or after, if any, and retires it once used. It runs under the
// world's lock, so two calls never take one use twice.
function takeGate(
  dir: string,
  args: readonly string[],
  before: boolean,
): Gate | null {
  const text = args.join("\n");
  const gates = gatesOf(dir);
  const gate = gates.find(
    (each) =>
      (each.before === true || each.drop === true) === before &&
      each.match.every((part) => text.includes(part)),
  );
  if (gate === undefined) {
    return null;
  }
  const uses = (gate.uses ?? 1) - 1;
  const rest = gates.filter((each) => each !== gate);
  if (uses > 0) {
    rest.push({ ...gate, uses });
  }
  fs.writeFileSync(gatesFile(dir), JSON.stringify(rest));
  return gate;
}

function gateOpen(dir: string, gate: Gate): boolean {
  return (
    fs.existsSync(path.join(dir, `${gate.name}.open`)) ||
    (gate.requests !== undefined && requestsHeld(dir, gate.requests))
  );
}

// Holds a reply at `gate`, outside the world's lock, until it opens.
function holdAtGate(dir: string, gate: Gate | null): void {
  if (gate === null) {
    return;
  }
  fs.appendFileSync(path.join(dir, `${gate.name}.reached`), "x");
  if (gate.kill === true) {
    process.kill(process.ppid, "SIGKILL");
    process.exit(1);
  }
  if (gate.drop === true) {
    return;
  }
  const deadline = Date.now() + GATE_MS;
  while (!gateOpen(dir, gate)) {
    if (Date.now() > deadline) {
      throw new Error(`fake-gh: gate ${gate.name} never opened`);
    }
    Atomics.wait(SLEEPER, 0, 0, POLL_MS);
  }
}

export type { Gate };
export { armGate, gateReached, hasGates, holdAtGate, openGate, takeGate };
