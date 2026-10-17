// @ts-check
// How each writer's task says to commit (#303; Pipeline-Roles-Shared,
// "Limiting git"): in a stage job, through `pipeline_commit`, small steps
// often, never running git's commit, push, rebase, reset, checkout or merge;
// in a lane, with plain git as before.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { committerOf, opsFrame } from "../src/workflow/launches.ts";
import { next as checks } from "../src/workflow/stages/checks.ts";
import { next as fix } from "../src/workflow/stages/fix.ts";
import { next as implement } from "../src/workflow/stages/implement.ts";
import { next as merge } from "../src/workflow/stages/merge.ts";
import { next as sync } from "../src/workflow/stages/sync.ts";
import { BUILD_CTX, buildState } from "./workflow-build-test-kit.mjs";
import { CTX as CHECKS_CTX, stateAt } from "./workflow-checks-test-kit.mjs";
import {
  CTX as FINISH_CTX,
  stateWith as finishState,
} from "./workflow-finish-test-kit.mjs";
import { fixState } from "./workflow-fix-test-kit.mjs";
import { CTX as REVIEW_CTX } from "./workflow-review-test-kit.mjs";

/** @import { Committer } from "../src/workflow/prompts.ts" */
/** @import { OpResult, StageContext, StageMachine, StageState, Step } from "../src/workflow/stages/types.ts" */

const FORBIDDEN = ["commit", "push", "rebase", "reset", "checkout", "merge"];
// A git command line that commits: `git commit`, `git add -A && git commit`,
// `git -C <wiki> commit` and the like.
const GIT_COMMIT_LINE = /`git[^`]*\bcommit\b[^`]*`/u;
const MANY_STEPS = /Commit often, in small working steps/u;
const FAILING = {
  ok: true,
  headSha: "cccccccccccccccc",
  pass: false,
  checks: [{ id: "test", pass: false, detail: "1 failed", tail: "3 != 2" }],
};
const CODE_CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};
const WIKI = "/w/issue-7/wiki";
const WIKI_CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["Home.md"],
  baseSha: "abcdefabcdefabcdef",
  branch: "master",
};

// The task of the one session `step` launches.
/** @param {Step} step @returns {string} */
function taskOf(step) {
  if (!step.done) {
    const [launch] = step.launches;
    if (launch.kind === "child") {
      return launch.task;
    }
  }
  throw new Error("expected a session");
}

// The session `next` launches from `given` once its op answers `reply`.
/**
 * @param {StageMachine["next"]} next @param {StageState} given
 * @param {OpResult["reply"]} reply @param {StageContext} ctx
 * @returns {string}
 */
function afterOp(next, given, reply, ctx) {
  const begun = next(given, ctx, []);
  return taskOf(next(begun.state, ctx, [{ kind: "op", reply }]));
}

/** @param {StageState} given @returns {StageState} */
function withWiki(given) {
  return { ...given, paths: { ...given.paths, wiki: WIKI } };
}

// Each writer's task, for writers that commit with `committer`.
/** @param {Committer} committer @returns {Record<string, string>} */
function writerTasks(committer) {
  const mergeCtx = { ...FINISH_CTX, committer };
  const checksCtx = { ...CHECKS_CTX, committer };
  return {
    implementer: taskOf(
      implement(
        buildState("implement", { spec: "Do it." }),
        { ...BUILD_CTX, committer },
        [],
      ),
    ),
    fixer: taskOf(fix(fixState(), { ...REVIEW_CTX, committer }, [])),
    "CI fixer": afterOp(checks, stateAt("checks"), FAILING, checksCtx),
    "code resolver": afterOp(sync, stateAt("sync"), CODE_CONFLICT, checksCtx),
    "wiki resolver": afterOp(
      merge,
      withWiki(finishState("merge", { acceptReason: "Does it." })),
      WIKI_CONFLICT,
      mergeCtx,
    ),
  };
}

describe("in a stage job, every writer's task", () => {
  const tasks = Object.entries(writerTasks("pipeline_commit"));

  test("says to commit small steps often with pipeline_commit", () => {
    for (const [writer, task] of tasks) {
      assert.match(task, MANY_STEPS, writer);
      assert.ok(task.includes("`pipeline_commit`"), writer);
    }
  });

  test("forbids running git's commit, push, rebase, reset, checkout and merge", () => {
    for (const [writer, task] of tasks) {
      for (const command of FORBIDDEN) {
        assert.ok(task.includes(`\`${command}\``), `${writer}: ${command}`);
      }
    }
  });

  test("gives no git command line that commits", () => {
    for (const [writer, task] of tasks) {
      assert.doesNotMatch(task, GIT_COMMIT_LINE, writer);
    }
  });

  test("lets only the resolvers continue their rebase with git", () => {
    const continues = tasks
      .filter(([, task]) => task.includes("rebase --continue"))
      .map(([writer]) => writer);
    assert.deepEqual(continues, ["code resolver", "wiki resolver"]);
  });
});

test("in a stage job, the implementer and fixer make the wiki updates and commit them with pipeline_commit", () => {
  const implementer = taskOf(
    implement(
      withWiki(buildState("implement", { spec: "Do it." })),
      { ...BUILD_CTX, committer: "pipeline_commit" },
      [],
    ),
  );
  const fixer = taskOf(
    fix(
      withWiki(fixState()),
      { ...REVIEW_CTX, committer: "pipeline_commit" },
      [],
    ),
  );
  assert.ok(implementer.includes("Make the wiki updates the spec lists"));
  assert.ok(fixer.includes("Make any wiki update the spec lists"));
  for (const task of [implementer, fixer]) {
    assert.ok(
      task.includes(
        `in the wiki checkout ${WIKI}: edit its pages and commit them with \`pipeline_commit\``,
      ),
    );
    assert.equal(task.includes("read-only"), false);
  }
});

test("in a lane, the fixer gets no wiki step", () => {
  const task = taskOf(
    fix(withWiki(fixState()), { ...REVIEW_CTX, committer: "git" }, []),
  );
  assert.equal(task.includes("Make any wiki update"), false);
});

test("in a lane, writers commit with git and never hear of pipeline_commit", () => {
  for (const [writer, task] of Object.entries(writerTasks("git"))) {
    assert.match(task, MANY_STEPS, writer);
    assert.equal(task.includes("pipeline_commit"), false, writer);
  }
  const { implementer = "" } = writerTasks("git");
  assert.match(implementer, GIT_COMMIT_LINE);
});

test("a sweep's writers commit with pipeline_commit only in a stage job", () => {
  const job = { config: "c.json", checkout: { issue: 7, dir: "/w/issue-7" } };
  assert.equal(committerOf(opsFrame(job, "s1", "l1")), "pipeline_commit");
  assert.equal(committerOf(opsFrame({ config: "c.json" }, "s1", "l1")), "git");
});
