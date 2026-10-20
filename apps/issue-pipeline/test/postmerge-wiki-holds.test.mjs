// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { readWorld, withWorld } from "./pipeline-flow-gh-world.mjs";
import { BASE, refIn, WIKI_BRANCH } from "./pipeline-flow-kit.mjs";
import {
  merges,
  replaceState,
  sessions,
} from "./pipeline-flow-replay-test-kit.mjs";
import { runStage, stopJobs } from "./pipeline-flow-run.mjs";
import { mergedWikiFlow, stateOf } from "./postmerge-wiki-test-kit.mjs";

/** @type {import("./pipeline-flow-kit.mjs").Flow} */
let flow;
/** @type {ReturnType<typeof stateOf>} */
let retained;
let config = "";
let evidence = "";
let source = "";
let wiki = "";
const HOME_REQUIRED = /required wiki updates \(Home\)/u;
const DISABLED = /wiki is disabled/u;
const WRONG_DIR = /wiki\.dir wrong-wiki/u;
const INACCESSIBLE =
  /cannot prepare configured wiki submodule wiki, base master/u;
const MISSING_BASE = /base unavailable/u;
const RECONCILE = /reconcile retained/u;
after(() => stopJobs(flow));

test("setup retains genuinely merged truth without a wiki branch or fabricated receipt", () => {
  flow = mergedWikiFlow();
  assert.equal(runStage(flow, "review").end, "deferred");
  retained = stateOf(flow);
  config = fs.readFileSync(flow.config, "utf8");
  evidence = path.join(flow.root, "runs/o__r/issue-7/recovery-evidence.txt");
  fs.writeFileSync(evidence, "retain operator evidence\n");
  source = String(refIn(flow.origin, BASE));
  wiki = String(refIn(flow.wikiOrigin, WIKI_BRANCH));
  assert.deepEqual(retained.flows, { code: true, wiki: false });
  assert.equal(retained.merged, null);
  assert.equal(retained.mergeAttempt, null);
});

/** @param {string} problem */
function configureProblem(problem) {
  replaceState(flow, retained);
  withWorld(flow.ghDir, (world) => {
    for (const issue of world.issues) {
      issue.labels = [];
    }
  });
  const settings = JSON.parse(config);
  if (problem === "disabled") {
    settings.wiki = false;
  } else if (problem === "incorrect directory") {
    settings.wiki = { dir: "wrong-wiki", branch: WIKI_BRANCH };
  } else if (problem === "missing base") {
    settings.wiki = { dir: "wiki", branch: "unavailable" };
  }
  fs.writeFileSync(flow.config, JSON.stringify(settings));
  if (problem === "inaccessible") {
    fs.renameSync(flow.wikiOrigin, `${flow.wikiOrigin}.retained`);
  }
}

/** @returns {{ end: string, report: string }} */
function attemptReview() {
  try {
    const result = runStage(flow, "review");
    return {
      end: result.end,
      report: readWorld(flow.ghDir)
        .comments.map(({ body }) => body)
        .join("\n"),
    };
  } catch (error) {
    return { end: "setup hold", report: String(error) };
  }
}

/** @param {string} problem */
function restoreConfiguration(problem) {
  fs.writeFileSync(flow.config, config);
  if (problem === "inaccessible") {
    fs.renameSync(`${flow.wikiOrigin}.retained`, flow.wikiOrigin);
  }
}

/** @param {{ problem: string, pattern: RegExp, end: string, retainedCheckout: boolean }} entry */
function requiredWikiHoldTest({ problem, pattern, end, retainedCheckout }) {
  test(`required wiki ${problem} holds before a model and retains merged authority and recovery evidence`, () => {
    configureProblem(problem);
    const before = sessions(flow);
    try {
      const result = attemptReview();
      assert.equal(result.end, end, result.report);
      assert.match(result.report, HOME_REQUIRED);
      assert.match(result.report, pattern);
      assert.match(result.report, RECONCILE);
      assert.equal(sessions(flow), before);
      const saved = stateOf(flow);
      for (const key of [
        "codeMerged",
        "gherkin",
        "security",
        "merged",
        "mergeAttempt",
        "hardened",
      ]) {
        assert.deepEqual(saved[key], retained[key], key);
      }
      assert.equal(
        fs.readFileSync(evidence, "utf8"),
        "retain operator evidence\n",
      );
      assert.equal(refIn(flow.origin, BASE), source);
      assert.equal(merges(flow).length, 0);
      const checkout = path.join(flow.root, "work/o__r/jobs/issue-7-review");
      assert.equal(fs.existsSync(checkout), retainedCheckout);
      if (retainedCheckout) {
        fs.renameSync(checkout, `${checkout}-${problem}`);
      }
    } finally {
      restoreConfiguration(problem);
    }
    assert.equal(refIn(flow.wikiOrigin, WIKI_BRANCH), wiki);
    assert.equal(refIn(flow.wikiOrigin, "agent/issue-7"), null);
  });
}

for (const entry of [
  {
    problem: "disabled",
    pattern: DISABLED,
    end: "stop",
    retainedCheckout: false,
  },
  {
    problem: "incorrect directory",
    pattern: WRONG_DIR,
    end: "stop",
    retainedCheckout: false,
  },
  {
    problem: "inaccessible",
    pattern: INACCESSIBLE,
    end: "setup hold",
    retainedCheckout: true,
  },
  {
    problem: "missing base",
    pattern: MISSING_BASE,
    end: "setup hold",
    retainedCheckout: true,
  },
]) {
  requiredWikiHoldTest(entry);
}
