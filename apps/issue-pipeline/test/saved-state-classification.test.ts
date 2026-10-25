// Failed PATCH diagnostics and quoted markers cannot become signed authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueComment } from "../src/comments.ts";
import { githubComment } from "./fake-gh.ts";
import { ISSUE, openJob } from "./pipeline-commit-test-kit.ts";
import {
  authorityCalls,
  saveAuthorityBodies,
} from "./write-authority-test-kit.ts";

const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const {
  readWriteState,
  readState,
  stateBody,
  writeState,
}: typeof import("../src/saved-state.ts") = await import(
  "../src/saved-state.ts"
);

const { pipelineRole, COMMENT, signed }: typeof import("../src/comments.ts") =
  await import("../src/comments.ts");

function comment(body: string): IssueComment {
  return COMMENT.parse(
    githubComment({
      id: 99,
      login: "bot",
      created: "2026-10-18T00:00:00Z",
      body,
    }),
  );
}

const ABSENT_AUTHORITY = /has no saved write authority/u;
const INVALID_AUTHORITY = /saved write authority is invalid/u;
const UNTRUSTED_AUTHORITY = /state has no merge authority/u;

test("canonical and raw state are eligible; account-authored coordinator/error/quoted state markers are not", async () => {
  const job = await openJob("implement");
  try {
    const merged = {
      ...newIssueState(ISSUE),
      branch: job.branch,
      codeMerged: { pr: 42, sha: "merged" },
    };
    const safe = stateBody(ISSUE, merged);
    const writable = `<!-- agent-pipeline:state\n${JSON.stringify(newIssueState(ISSUE))}\n-->`;
    for (const body of [
      safe,
      `<!-- agent-pipeline:state\n${JSON.stringify(merged)}\n-->`,
    ]) {
      saveAuthorityBodies(job.cfg, [
        body,
        `**🤖 issue-pipeline · coordinator**\nReason: gh PATCH body=${writable}`,
        `Quoted:\n${writable}`,
        `> ${safe}`,
      ]);
      assert.equal(pipelineRole(job.cfg, comment(body)), "state");
      assert.equal(
        pipelineRole(
          job.cfg,
          comment(
            signed({ role: "coordinator" }, `Failed PATCH body=${writable}`),
          ),
        ),
        "coordinator",
      );
      assert.equal(
        pipelineRole(job.cfg, comment(`Quoted:\n${writable}`)),
        null,
      );
      assert.deepEqual(readWriteState(job.cfg, ISSUE), merged);
      assert.deepEqual(readState(job.cfg, ISSUE).state, merged);
    }
    saveAuthorityBodies(job.cfg, [
      `**🤖 issue-pipeline · coordinator**\n${writable}`,
    ]);
    assert.throws(() => readWriteState(job.cfg, ISSUE), ABSENT_AUTHORITY);
    assert.equal(readState(job.cfg, ISSUE).state, null);
  } finally {
    job.close();
  }
});

test("a malformed latest eligible state cannot revive older writable authority", async () => {
  const job = await openJob("implement");
  try {
    const older = stateBody(ISSUE, newIssueState(ISSUE));
    for (const malformed of [
      "<!-- agent-pipeline:state\nnot JSON\n-->",
      "**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n{}\n-->",
    ]) {
      saveAuthorityBodies(job.cfg, [older, malformed]);
      let refusal: RegExp | typeof SyntaxError = INVALID_AUTHORITY;
      if (malformed.includes("not JSON")) {
        refusal = SyntaxError;
      }
      assert.throws(() => readWriteState(job.cfg, ISSUE), refusal);
    }
  } finally {
    job.close();
  }
});

test("state upsert retains genuine comment identity despite newer diagnostic markers; outsider states grant nothing", async () => {
  const job = await openJob("implement");
  try {
    const state = newIssueState(ISSUE);
    const diagnostic = signed(
      { role: "coordinator" },
      `Failed PATCH body=${stateBody(ISSUE, state)}`,
    );
    saveAuthorityBodies(job.cfg, [stateBody(ISSUE, state), diagnostic]);
    writeState(job.cfg, ISSUE, {
      ...state,
      stage: "stopped",
      stoppedStage: "implement",
      stopCode: "error",
    });
    const patched = authorityCalls(job.cfg).filter((args) =>
      args.includes("PATCH"),
    );
    assert.equal(patched.length, 1);
    assert.ok(patched[0]?.includes(`repos/${job.cfg.repo}/issues/comments/1`));
    assert.equal(readState(job.cfg, ISSUE).id, 1);
    assert.equal(readWriteState(job.cfg, ISSUE).stage, "stopped");
    saveAuthorityBodies({ ...job.cfg, mergeAccount: "outsider" }, [
      stateBody(ISSUE, state),
    ]);
    assert.throws(() => readWriteState(job.cfg, ISSUE), UNTRUSTED_AUTHORITY);
    assert.throws(() => readState(job.cfg, ISSUE), UNTRUSTED_AUTHORITY);
    assert.equal(
      pipelineRole(job.cfg, {
        ...comment(stateBody(ISSUE, state)),
        user: { login: "outsider" },
      }),
      null,
    );
  } finally {
    job.close();
  }
});
