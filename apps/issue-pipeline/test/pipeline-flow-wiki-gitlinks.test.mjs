// @ts-check
// Two actual divergent code/wiki issues, using the built jobs, real Git and
// the fake model/GitHub. Selecting a gitlink must not integrate wiki history.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, test } from "node:test";
import { ghCalls, openIssue } from "./pipeline-flow-gh.mjs";
import { readWorld } from "./pipeline-flow-gh-world.mjs";
import {
  BASE,
  bareGit,
  refIn,
  scriptPi,
  setUpFlow,
  WIKI_BRANCH,
} from "./pipeline-flow-kit.mjs";
import { piLog } from "./pipeline-flow-pi.mjs";
import { runStage } from "./pipeline-flow-run.mjs";
import {
  authorTurn,
  hardeningTurn,
  savedState,
  securityTurn,
} from "./pipeline-flow-script.mjs";

const FIRST = 7;
const SECOND = 8;
const GHERKIN =
  "Feature: separate contributions\n  Scenario: both retained\n    Then both code and wiki contributions survive integration";
const MERGE_ENDPOINT = /^repos\/[^/]+\/[^/]+\/merges$/u;
/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {{ code: string, wiki: string }} */
let secondOriginal;

/** @param {string} dir @param {string[]} args @returns {string} */
function git(dir, args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Seed",
      "-c",
      "user.email=seed@example.invalid",
      "-C",
      dir,
      ...args,
    ],
    { env: flow.env, encoding: "utf8" },
  ).trim();
}

/** @param {number} n @returns {import("./pipeline-flow-pi.mjs").FlowTurn} */
function contribution(n) {
  let page = "Home.md";
  if (n === SECOND) {
    page = "Extra.md";
  }
  return {
    files: {
      [`repo/issue-${n}.txt`]: `code ${n}\n`,
      [`docs/${page}`]: `wiki contribution ${n}\n`,
    },
    commits: [
      ["-m", `Contribute ${n}`, "--", `repo/issue-${n}.txt`, `docs/${page}`],
    ],
    pinWiki: true,
    output: { outcome: "done", summary: `Contributed ${n}` },
  };
}

before(() => {
  flow = setUpFlow();
  const wikiSeed = path.join(flow.tmp, "wiki-seed");
  fs.writeFileSync(path.join(wikiSeed, "Extra.md"), "Extra base\n");
  fs.writeFileSync(
    path.join(wikiSeed, "_Sidebar.md"),
    "- [Home](Home)\n- [Extra](Extra)\n",
  );
  git(wikiSeed, ["add", "."]);
  git(wikiSeed, ["commit", "-qm", "Seed independent pages"]);
  git(wikiSeed, ["push", flow.wikiOrigin, `HEAD:${WIKI_BRANCH}`]);
  const pin = git(wikiSeed, ["rev-parse", "HEAD"]);
  const seed = path.join(flow.tmp, "seed");
  for (const n of [FIRST, SECOND]) {
    fs.writeFileSync(path.join(seed, `issue-${n}.txt`), "base\n");
  }
  git(seed, ["add", "issue-7.txt", "issue-8.txt"]);
  git(seed, ["update-index", "--cacheinfo", "160000", pin, "wiki"]);
  git(seed, ["commit", "-qm", "Pin seeded pages"]);
  git(seed, ["push", flow.origin, `HEAD:${BASE}`]);
  for (const number of [FIRST, SECOND]) {
    openIssue(flow.ghDir, {
      number,
      title: `Contribution ${number}`,
      body: GHERKIN,
      login: "alice",
    });
  }
  scriptPi(flow, {
    author: [authorTurn(GHERKIN, true), authorTurn(GHERKIN, true)],
    implementor: [contribution(FIRST), contribution(SECOND)],
    reviewer: [
      hardeningTurn(),
      hardeningTurn(),
      securityTurn(),
      securityTurn(),
    ],
  });
});

/** @param {string} stage @param {number} issue */
function completeStage(stage, issue) {
  const result = runStage(flow, stage, issue);
  return {
    result,
    state: savedState(readWorld(flow.ghDir), issue),
    log: JSON.stringify({
      result,
      state: savedState(readWorld(flow.ghDir), issue),
    }),
  };
}

for (const stage of ["author", "implement", "review"]) {
  for (const issue of [FIRST, SECOND]) {
    test(`issue ${issue} completes ${stage} from the shared bases`, () => {
      const { result, state, log } = completeStage(stage, issue);
      assert.notEqual(result.end, "stop", log);
      let expected = "review";
      if (stage === "author") {
        expected = "implement";
      }
      if (stage === "review") {
        expected = "merge";
      }
      assert.equal(state.stage, expected, log);
    });
  }
}

test("first issue merges and publishes normally while the second private wiki pin stays recoverable", () => {
  const world = readWorld(flow.ghDir);
  const second = savedState(world, SECOND);
  secondOriginal = { code: second.hardened.code, wiki: second.hardened.wiki };
  const first = savedState(world, FIRST);
  assert.notEqual(first.hardened.wiki, secondOriginal.wiki);
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${secondOriginal.code}:wiki`]),
    secondOriginal.wiki,
  );
  runStage(flow, "merge", FIRST);
  const done = savedState(readWorld(flow.ghDir), FIRST);
  assert.equal(done.stage, "done", JSON.stringify(done.log));
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), done.merged.wiki);
  assert.equal(
    refIn(flow.wikiOrigin, `agent/issue-${SECOND}`),
    secondOriginal.wiki,
  );
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${BASE}:wiki`]),
    done.merged.wiki,
  );
});

test("second synchronization consumes no model conflict attempt and replaces the temporary pin with the integrated wiki before authorization", () => {
  const starts = piLog(flow.piDir).filter(
    (entry) => entry.start === true,
  ).length;
  runStage(flow, "merge", SECOND);
  const integrated = savedState(readWorld(flow.ghDir), SECOND);
  assert.equal(integrated.stage, "merge");
  assert.equal(integrated.counts.conflictFixes, 0);
  assert.equal(
    piLog(flow.piDir).filter((entry) => entry.start === true).length,
    starts,
  );
  assert.ok(integrated.integration !== null);
  assert.equal(integrated.integration.reviewed.wiki, secondOriginal.wiki);
  const result = integrated.integration.revision;
  assert.notEqual(result.wiki, secondOriginal.wiki);
  assert.notEqual(result.wiki, refIn(flow.wikiOrigin, WIKI_BRANCH));
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${result.code}:wiki`]),
    result.wiki,
  );
  assert.equal(integrated.verifiedSha, result.code);
  for (const [page, text] of [
    ["Home.md", "wiki contribution 7"],
    ["Extra.md", "wiki contribution 8"],
  ]) {
    assert.equal(
      bareGit(flow.wikiOrigin, ["show", `${result.wiki}:${page}`]),
      text,
    );
  }
  assert.equal(
    bareGit(flow.wikiOrigin, ["show", `${secondOriginal.wiki}:Extra.md`]),
    "wiki contribution 8",
  );
});

test("second exact-head merge, merged-result security and guarded wiki publication retain both contributions", () => {
  runStage(flow, "merge", SECOND);
  const world = readWorld(flow.ghDir);
  const done = savedState(world, SECOND);
  assert.equal(done.stage, "done");
  assert.equal(done.counts.conflictFixes, 0);
  assert.deepEqual(done.security.revision, done.merged);
  assert.equal(done.security.finding, null);
  assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), done.merged.wiki);
  assert.equal(
    bareGit(flow.origin, ["rev-parse", `${BASE}:wiki`]),
    done.merged.wiki,
  );
  for (const n of [FIRST, SECOND]) {
    assert.equal(
      bareGit(flow.origin, ["show", `${BASE}:issue-${n}.txt`]),
      `code ${n}`,
    );
  }
  assert.deepEqual(world.unsupported, []);
  const merges = ghCalls(flow.ghDir).filter(
    (args) =>
      args[0] === "api" &&
      args.some((arg) => MERGE_ENDPOINT.test(arg)) &&
      args.includes("POST"),
  );
  assert.equal(merges.length, 2);
});
