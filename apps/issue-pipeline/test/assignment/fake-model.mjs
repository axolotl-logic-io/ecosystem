// @ts-check

import { emptyCoordination } from "../../src/assignment/schema.ts";
import { ISSUE_STATE, newIssueState } from "../../src/state.ts";
import { pull } from "./fake-wire.mjs";
import { CODE, TREE, WIKI } from "./world.mjs";

/** @import { World } from './world.mjs' */
/** @import { Execution } from '../../src/assignment/schema.ts' */
/** @import { JobResult } from '../../src/assignment/worker-state.ts' */
/** @param {World} f @param {import('../../src/state.ts').IssueState} state */
function implement(f, state) {
  const pr = pull(f, state.number);
  state.pr = pr.number;
  state.headSha = CODE;
  state.stage = "review";
  state.coordination = {
    ...emptyCoordination(),
    checkpoint: {
      code: CODE,
      wiki: WIKI,
      inputs: f.world.inputs,
      branch: state.branch ?? "",
      pr: pr.number,
      at: new Date(f.world.now).toISOString(),
    },
  };
  f.refs.set(`heads/${state.branch}`, CODE);
}
/** @param {World} f @param {import('../../src/state.ts').IssueState} state */
function merge(f, state) {
  state.stage = "done";
  state.codeMerged = { pr: state.pr ?? 1, sha: TREE };
  state.merged = { code: TREE, wiki: WIKI, inputs: f.world.inputs };
  state.security = {
    revision: state.merged,
    finding: null,
    commentId: state.number,
  };
  const row = f.issues.get(state.number);
  if (row !== undefined) {
    row.state = "closed";
  }
}
/** @param {World} f @param {Execution} execution @returns {JobResult} */
function model(f, execution) {
  const state = f.states.get(execution.issue) ?? newIssueState(execution.issue);
  state.branch = `agent/issue-${execution.issue}`;
  state.coordination ??= emptyCoordination();
  if (execution.stage === "author") {
    state.stage = "implement";
    state.gherkin = { commentId: state.number, rev: 1, inputs: f.world.inputs };
  } else if (execution.stage === "implement") {
    implement(f, state);
  } else if (execution.stage === "review") {
    state.stage = "merge";
    state.hardened = { code: CODE, wiki: WIKI, inputs: f.world.inputs };
  } else {
    merge(f, state);
  }
  f.states.set(state.number, ISSUE_STATE.parse(state));
  return { end: "next", reason: null, localRecovery: false };
}

export { model };
