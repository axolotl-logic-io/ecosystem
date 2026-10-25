// @ts-check
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
import { readWorld } from "./fake-pipeline-flow-gh-world.mjs";

const POLL_MS = 10;
const GATE_MS = 60_000;
const SLEEPER = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);
const REQUEST = /"kind":"request"/u;

/**
 * @typedef {object} Gate
 * @property {string} name the gate's files are `<name>.reached` and `<name>.open`
 * @property {string[]} match substrings that together select the call
 * @property {boolean} [before] hold the call before the world answers it
 * @property {boolean} [drop] lose the call: no write, a 502 reply
 * @property {boolean} [kill] kill the process that made the call (SIGKILL)
 * @property {{ issue: number, count: number }} [requests] open once the world holds this many coordination requests on the issue
 * @property {number} [uses] calls the gate holds before it retires, default 1
 */

/** @param {string} dir @returns {string} */
function gatesFile(dir) {
  return path.join(dir, "gates.json");
}

/** @param {string} dir @returns {Gate[]} */
function gatesOf(dir) {
  if (!fs.existsSync(gatesFile(dir))) {
    return [];
  }
  return JSON.parse(fs.readFileSync(gatesFile(dir), "utf8"));
}

/** @param {string} dir @returns {boolean} whether a test ever armed a gate here */
function hasGates(dir) {
  return fs.existsSync(gatesFile(dir));
}

/** Arms `gate` in the fake GitHub in `dir`. @param {string} dir @param {Gate} gate */
function armGate(dir, gate) {
  const gates = gatesOf(dir).filter(({ name }) => name !== gate.name);
  fs.writeFileSync(gatesFile(dir), JSON.stringify([...gates, gate]));
}

/** Opens the gate named `name`. @param {string} dir @param {string} name */
function openGate(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.open`), "");
}

/** @param {string} dir @param {string} name @returns {boolean} whether a call reached the gate */
function gateReached(dir, name) {
  return fs.existsSync(path.join(dir, `${name}.reached`));
}

/** @param {string} dir @param {{ issue: number, count: number }} wanted @returns {boolean} */
function requestsHeld(dir, { issue, count }) {
  const { comments } = readWorld(dir);
  const held = comments.filter(
    (each) => each.issue === issue && REQUEST.test(each.body),
  );
  return held.length >= count;
}

/**
 * Takes the gate the call `args` selects at this point, `before` the world
 * answers or after, if any, and retires it once used. It runs under the
 * world's lock, so two calls never take one use twice.
 * @param {string} dir @param {readonly string[]} args @param {boolean} before
 * @returns {Gate | null}
 */
function takeGate(dir, args, before) {
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

/** @param {string} dir @param {Gate} gate @returns {boolean} */
function gateOpen(dir, gate) {
  return (
    fs.existsSync(path.join(dir, `${gate.name}.open`)) ||
    (gate.requests !== undefined && requestsHeld(dir, gate.requests))
  );
}

/**
 * Holds a reply at `gate`, outside the world's lock, until it opens.
 * @param {string} dir @param {Gate | null} gate
 */
function holdAtGate(dir, gate) {
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

export { armGate, gateReached, hasGates, holdAtGate, openGate, takeGate };
