// @ts-check
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import {
  calls,
  consumed,
  post,
  prStep,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import { BASE, git, ISSUE, world } from "../explicit-target-world-test-kit.mjs";

const { branchMerge } = await import("../../src/ops/branch-merge.ts");
const { merge } = await import("../../src/ops/merge.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const DESTINATION = /one unchanged fetch and push destination/u;

/** @typedef {import("../explicit-target-world-test-kit.mjs").World} World */
/** @param {World} w @returns {string} */
function rawConfig(w) {
  return execFileSync(
    "git",
    ["-C", w.wt, "config", "--local", "--null", "--list"],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}
/** @param {World} w @param {string} alternate @returns {Map<string, [string, string][]>} */
function destinationSettings(w, alternate) {
  /** @type {Map<string, [string, string][]>} */
  return new Map([
    ["alternate push", [["remote.origin.pushurl", alternate]]],
    ["padded push", [["remote.origin.pushurl", alternate]]],
    ["leading push", [["remote.origin.pushurl", ` ${w.origin}`]]],
    ["padded origin", [["remote.origin.url", alternate]]],
    ["leading origin", [["remote.origin.url", ` ${w.origin}`]]],
    ["blank origin", [["remote.origin.url", ""]]],
    ["blank push", [["remote.origin.pushurl", ""]]],
    ["blank fetch record", [["remote.origin.url", ""]]],
    [
      "blank push record",
      [
        ["remote.origin.pushurl", w.origin],
        ["remote.origin.pushurl", ""],
      ],
    ],
    ["tab origin", [["remote.origin.url", `${w.origin}\tmore`]]],
    ["newline origin", [["remote.origin.url", `${w.origin}\n${w.origin}`]]],
    ["control push", [["remote.origin.pushurl", `${w.origin}\u0001more`]]],
    ["carriage return push", [["remote.origin.pushurl", `${w.origin}\r`]]],
    [
      "multiple pushes",
      [
        ["remote.origin.pushurl", w.origin],
        ["remote.origin.pushurl", alternate],
      ],
    ],
    [
      "duplicate pushes",
      [
        ["remote.origin.pushurl", w.origin],
        ["remote.origin.pushurl", w.origin],
      ],
    ],
    ["multiple fetches", [["remote.origin.url", alternate]]],
    ["duplicate fetches", [["remote.origin.url", w.origin]]],
    ["fetch rewrite", [[`url.${alternate}.insteadOf`, w.origin]]],
    ["push rewrite", [[`url.${alternate}.pushInsteadOf`, w.origin]]],
    [
      "rewritten pushurl",
      [
        ["remote.origin.pushurl", w.origin],
        [`url.${alternate}.insteadOf`, w.origin],
      ],
    ],
  ]);
}
/** @param {World} w @param {string} mode @returns {string} */
function redirect(w, mode) {
  // Both repositories exist with the same old target. Padding is path data.
  const alternate = `${w.origin} `;
  git(w.place, ["clone", "-q", "--mirror", w.origin, alternate]);
  const entries = destinationSettings(w, alternate).get(mode);
  if (entries === undefined) {
    throw new Error(`unknown destination fixture ${mode}`);
  }
  if (mode.endsWith("origin")) {
    git(w.wt, ["config", "--unset-all", "remote.origin.url"]);
  }
  for (const [key, value] of entries) {
    git(w.wt, ["config", "--add", key, value]);
  }
  return alternate;
}

for (const mode of [
  "alternate push",
  "padded push",
  "leading push",
  "padded origin",
  "leading origin",
  "blank origin",
  "blank push",
  "blank fetch record",
  "blank push record",
  "tab origin",
  "newline origin",
  "control push",
  "carriage return push",
  "multiple pushes",
  "duplicate pushes",
  "multiple fetches",
  "duplicate fetches",
  "fetch rewrite",
  "push rewrite",
  "rewritten pushurl",
]) {
  for (const boundary of ["transport", "pre-arm"]) {
    test(`${boundary} refuses ${mode} without mutating either destination or arming an attempt`, () => {
      const w = world({ fastForward: true });
      const alternate = redirect(w, mode);
      assert.notEqual(fs.realpathSync(alternate), fs.realpathSync(w.origin));
      assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
      const config = rawConfig(w);
      script(w, []);
      if (boundary === "pre-arm") {
        script(w, [prStep(w)]);
      }
      /** @returns {unknown} */
      function attempt() {
        if (boundary === "pre-arm") {
          return merge(w.cfg, request(w));
        }
        return branchMerge(w.cfg, w.wt, w.base, w.head);
      }
      assert.throws(attempt, DESTINATION);
      assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
      assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
      assert.equal(rawConfig(w), config);
      assert.equal(readWriteState(w.cfg, ISSUE).mergeAttempt, null);
      assert.equal(
        calls().some(
          (args) => args.includes("push") || args.includes("event=APPROVE"),
        ),
        false,
      );
      consumed();
    });
  }
}

test("one explicit push URL equal to the raw validated origin remains the same destination", () => {
  const w = world({ fastForward: true });
  git(w.wt, ["config", "remote.origin.pushurl", w.origin]);
  script(w, [post(w)]);
  assert.equal(branchMerge(w.cfg, w.wt, w.base, w.head), true);
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.head);
  consumed();
});
