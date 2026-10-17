// @ts-check
// A restart's check of the files its spec documents (src/restart-spec.ts)
// counts a test or stub file as missing only when the spec head, the saved
// `specTestsSha`, didn't have it either (#408): a branch that deleted or
// moved a documented file since the spec head isn't stopped for it. A state
// with no spec head, or one the checkout can't resolve, keeps the rule
// before #408: the files of the branch's HEAD.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setEnv } from "./ops-run-test-kit.mjs";
import { claimAt } from "./workflow-stages-fixtures.mjs";

const d = fs.mkdtempSync("/tmp/issue-pipeline-test-");
process.on("exit", () => fs.rmSync(d, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", d);
const { checkedSpecFiles, specFilesMissing } = await import(
  "../src/restart-spec.ts"
);
const { claimStep } = await import("../src/workflow/stages/entry.ts");

const SPEC = [
  "## Tests",
  "",
  "- `test/thing.test.mjs`: the thing, with `test/thing-kit.mjs`.",
  "- `test/never.test.mjs`: written by nobody.",
].join("\n");
const SPEC_WITHOUT_NEVER = SPEC.replace(/\n- `test\/never.*$/u, "");
// The one `new` interface; its `where` is its stub.
const INTERFACES = [
  {
    name: "thing",
    kind: "function",
    where: "src/thing.ts",
    status: "new",
    signature: "thing(): void",
    behaviours: [],
  },
];
const SPEC_HEAD_FILES = [
  "test/thing.test.mjs",
  "test/thing-kit.mjs",
  "src/thing.ts",
];
const ISSUE = 7;
const NOW = new Date("2026-10-17T20:00:00Z");
const WIKI_DIR = "wiki";
const SHA_LENGTH = 40;
// A sha no commit in the checkout has.
const UNKNOWN_SHA = "0".repeat(SHA_LENGTH);

/**
 * Runs git with `args` in `wt`, as a test user, and gives its output.
 * @param {string} wt
 * @param {readonly string[]} args
 * @returns {string}
 */
function git(wt, args) {
  const user = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const out = spawnSync("git", ["-C", wt, ...user, ...args], {
    encoding: "utf8",
  });
  return out.stdout.trim();
}

/**
 * A git checkout at `name` with two commits: the spec head, which holds
 * SPEC_HEAD_FILES, each empty, and HEAD, which runs git `change` on it
 * (such as `["rm", "-q", file]`). Gives the checkout and the spec head's sha.
 * @param {string} name
 * @param {readonly string[]} change
 * @returns {{ wt: string, specHead: string }}
 */
function changedSinceSpec(name, change) {
  const wt = path.join(d, name);
  for (const file of SPEC_HEAD_FILES) {
    fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
    fs.writeFileSync(path.join(wt, file), "");
  }
  git(wt, ["init", "-q"]);
  git(wt, ["add", "."]);
  git(wt, ["commit", "-qm", "spec"]);
  const specHead = git(wt, ["rev-parse", "HEAD"]);
  git(wt, change);
  git(wt, ["commit", "-qam", "change"]);
  return { wt, specHead };
}

/**
 * A restart past spec of SPEC_WITHOUT_NEVER's spec writer, at `specHead`.
 * @param {string | undefined} specHead
 * @returns {{ stage: string, spec: string, interfaces: object[], specWritesTests: boolean, specTestsSha: string | undefined }}
 */
function restartAt(specHead) {
  return {
    stage: "implement",
    spec: SPEC_WITHOUT_NEVER,
    interfaces: INTERFACES,
    specWritesTests: true,
    specTestsSha: specHead,
  };
}

test("a documented file the branch deleted since the spec head is not missing, and the claim carries on", () => {
  const kit = "test/thing-kit.mjs";
  const { wt, specHead } = changedSinceSpec("deleted", ["rm", "-q", kit]);
  const state = restartAt(specHead);
  const missing = specFilesMissing(wt, state, WIKI_DIR);
  assert.deepEqual(missing, []);
  const { specMissing } = checkedSpecFiles(state, missing, NOW);
  const step = claimStep(ISSUE, { ...claimAt("implement"), specMissing });
  assert.equal(step.kind === "claimed" && step.stop, null);
});

test("a documented file the branch moved since the spec head is not missing", () => {
  const moved = ["mv", "test/thing-kit.mjs", "test/other-kit.mjs"];
  const { wt, specHead } = changedSinceSpec("moved", moved);
  assert.deepEqual(specFilesMissing(wt, restartAt(specHead), WIKI_DIR), []);
});

test("a new interface's stub deleted since the spec head is not missing", () => {
  const { wt, specHead } = changedSinceSpec("stub", [
    "rm",
    "-q",
    "src/thing.ts",
  ]);
  assert.deepEqual(specFilesMissing(wt, restartAt(specHead), WIKI_DIR), []);
});

test("a documented file neither the spec head nor HEAD has stops the restart, naming only it", () => {
  const test1 = "test/thing.test.mjs";
  const { wt, specHead } = changedSinceSpec("never", ["rm", "-q", test1]);
  const state = { ...restartAt(specHead), spec: SPEC };
  const missing = specFilesMissing(wt, state, WIKI_DIR);
  assert.deepEqual(missing, ["test/never.test.mjs"]);
  const { specMissing } = checkedSpecFiles(state, missing, NOW);
  assert.deepEqual(specMissing, ["test/never.test.mjs"]);
  const step = claimStep(ISSUE, { ...claimAt("implement"), specMissing });
  assert.equal(step.kind === "claimed" && step.stop?.code, "spec-files");
});

test("a state with no spec head, or one the checkout lacks, checks the files at HEAD", () => {
  const kit = "test/thing-kit.mjs";
  const { wt } = changedSinceSpec("no-spec-head", ["rm", "-q", kit]);
  for (const specHead of [undefined, "", UNKNOWN_SHA]) {
    const missing = specFilesMissing(wt, restartAt(specHead), WIKI_DIR);
    assert.deepEqual(missing, [kit], `specTestsSha ${String(specHead)}`);
  }
});
