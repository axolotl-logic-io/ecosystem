// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  calls,
  consumed,
  post,
  prechecks,
  request,
  script,
} from "./explicit-target-test-kit.mjs";
import { BASE, git, ISSUE, world } from "./explicit-target-world-test-kit.mjs";

const { branchMerge } = await import("../src/ops/branch-merge.ts");
const { merge } = await import("../src/ops/merge.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const DESTINATION = /one unchanged fetch and push destination/u;

/** @typedef {import("./explicit-target-world-test-kit.mjs").World} World */
/** @param {World} w @param {string} mode @returns {string} */
function redirect(w, mode) {
  const alternate = path.join(w.place, "alternate.git");
  git(w.place, ["clone", "-q", "--mirror", w.origin, alternate]);
  /** @type {Map<string, [string, string][]>} */
  const settings = new Map([
    ["alternate push", [["remote.origin.pushurl", alternate]]],
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
  const entries = settings.get(mode);
  if (entries === undefined) {
    throw new Error(`unknown destination fixture ${mode}`);
  }
  for (const [key, value] of entries) {
    git(w.wt, ["config", "--add", key, value]);
  }
  return alternate;
}

for (const mode of [
  "alternate push",
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
      const config = git(w.wt, ["config", "--local", "--list"]);
      script(w, []);
      if (boundary === "pre-arm") {
        script(w, prechecks(w).slice(0, -1));
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
      assert.equal(git(w.wt, ["config", "--local", "--list"]), config);
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
