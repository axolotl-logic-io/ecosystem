// @ts-check
// Git config and POSIX paths can carry bytes that the shared UTF-8 runner
// cannot distinguish. Refusal must precede approval, intent and transport.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  calls,
  consumed,
  post,
  prStep,
  request,
  script,
} from "./explicit-target-test-kit.mjs";
import { BASE, git, ISSUE, world } from "./explicit-target-world-test-kit.mjs";

const { branchMerge } = await import("../src/ops/branch-merge.ts");
const { merge } = await import("../src/ops/merge.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const DESTINATION = /one unchanged fetch and push destination/u;
const INVALID_FETCH_BYTE = 0xff;
const INVALID_PUSH_BYTE = 0xfe;
/** @typedef {import("./explicit-target-world-test-kit.mjs").World} World */

/** @param {World} w @param {string} mode */
function byteDestinations(w, mode) {
  let fetch = Buffer.from(w.origin);
  let push = Buffer.concat([fetch, Buffer.from([INVALID_PUSH_BYTE])]);
  let alternate = `${w.origin} `;
  if (mode === "colliding invalid bytes") {
    fetch = Buffer.concat([fetch, Buffer.from([INVALID_FETCH_BYTE])]);
  }
  if (mode === "literal replacement") {
    alternate = `${w.origin}\uFFFD`;
    push = Buffer.from(alternate);
  }
  // This filesystem refuses invalid UTF-8 names. Invalid config bytes are
  // still real Git input; the two real refs are independent no-push controls.
  git(w.place, ["clone", "-q", "--mirror", w.origin, alternate]);
  const config = path.resolve(
    w.wt,
    git(w.wt, ["rev-parse", "--git-common-dir"]),
    "config",
  );
  git(w.wt, ["config", "--unset-all", "remote.origin.url"]);
  fs.appendFileSync(
    config,
    Buffer.concat([
      Buffer.from('\n[remote "origin"]\nurl = '),
      fetch,
      Buffer.from("\npushurl = "),
      push,
      Buffer.from("\n"),
    ]),
  );
  return { fetch, push, config, alternate };
}

for (const mode of [
  "invalid push bytes",
  "colliding invalid bytes",
  "literal replacement",
]) {
  for (const boundary of ["transport", "pre-arm"]) {
    test(`${boundary} refuses ${mode} without erasing configuration or touching either bare target`, () => {
      const w = world({ fastForward: true });
      const { fetch, push, config, alternate } = byteDestinations(w, mode);
      const before = fs.readFileSync(config);
      assert.notDeepEqual(fetch, push);
      assert.notEqual(fs.realpathSync(w.origin), fs.realpathSync(alternate));
      assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
      assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
      script(w, []);
      if (boundary === "pre-arm") {
        script(w, [prStep(w)]);
      }
      function attempt() {
        if (boundary === "pre-arm") {
          return merge(w.cfg, request(w));
        }
        return branchMerge(w.cfg, w.wt, w.base, w.head);
      }
      assert.throws(attempt, DESTINATION);
      assert.deepEqual(fs.readFileSync(config), before);
      assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
      assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
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

test("native Git emits distinct invalid destination bytes that decode identically", () => {
  const w = world({ fastForward: true });
  const { fetch, push, alternate } = byteDestinations(
    w,
    "colliding invalid bytes",
  );
  const rawFetch = execFileSync(
    "git",
    ["-C", w.wt, "config", "--null", "--get-all", "remote.origin.url"],
    { timeout: 20_000 },
  );
  const rawPush = execFileSync(
    "git",
    ["-C", w.wt, "remote", "get-url", "--push", "--all", "origin"],
    { timeout: 20_000 },
  );
  assert.deepEqual(rawFetch, Buffer.concat([fetch, Buffer.from([0])]));
  assert.deepEqual(rawPush, Buffer.concat([push, Buffer.from("\n")]));
  assert.notDeepEqual(fetch, push);
  assert.equal(fetch.toString("utf8"), push.toString("utf8"));
  assert.equal(git(w.origin, ["rev-parse", BASE]), w.base);
  assert.equal(git(alternate, ["rev-parse", BASE]), w.base);
});

test("an ordinary non-ASCII local destination remains valid without normalization", () => {
  const w = world({ fastForward: true });
  const origin = path.join(w.place, "dépôt-東京.git");
  fs.renameSync(w.origin, origin);
  w.origin = origin;
  git(w.wt, ["remote", "set-url", "origin", origin]);
  git(w.wt, ["config", "remote.origin.pushurl", origin]);
  script(w, [post(w)]);
  assert.equal(branchMerge(w.cfg, w.wt, w.base, w.head), true);
  assert.equal(git(origin, ["rev-parse", BASE]), w.head);
  consumed();
});
