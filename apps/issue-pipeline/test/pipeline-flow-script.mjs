// @ts-check
// The full-flow tests' scripting: the issue a flow starts from, the model
// turns the fake pi plays, and the issue's saved state as its state comment
// on the fake GitHub holds it.
import { newIssueState } from "../src/state.ts";
import { openIssue } from "./pipeline-flow-gh.mjs";
import { withWorld } from "./pipeline-flow-gh-world.mjs";
import { ISSUE } from "./pipeline-flow-kit.mjs";

const STATE =
  /^(?:\*\*🤖 issue-pipeline · state\*\*\n)?<!-- agent-pipeline:state\n(?<json>[\s\S]*?)\n-->/u;

/**
 * Opens the flow's issue on the fake GitHub.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
 * @param {string} login @param {string} title @param {string} body
 */
function openFlowIssue(flow, login, title, body) {
  openIssue(flow.ghDir, { number: ISSUE, title, body, login });
}

/** A saved pre-optional-Author run, without a mode marker.
 * @param {import("./pipeline-flow-kit.mjs").Flow} flow
 */
function retainAuthoredIssue(flow) {
  const {
    authorUsed: _mode,
    requirementsInputs: _inputs,
    ...saved
  } = newIssueState(ISSUE, "author");
  withWorld(flow.ghDir, (world) => {
    world.comments.push({
      id: world.nextId,
      issue: ISSUE,
      login: world.account,
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:00:00Z",
      body: `<!-- agent-pipeline:state\n${JSON.stringify(saved)}\n-->`,
    });
    world.nextId += 1;
  });
}

/**
 * The author's turn that writes `gherkin`.
 * @param {string} gherkin @param {boolean} changed
 */
function authorTurn(gherkin, changed) {
  return {
    output: {
      outcome: "gherkin",
      gherkin,
      assumptions: [],
      changed,
    },
  };
}

/**
 * An implementor's turn that writes the greeting and the docs' word on it,
 * commits them through pipeline_commit and replies done.
 * @param {string} greeting @param {string} message
 */
function implementorTurn(greeting, message) {
  return {
    files: {
      "repo/greet.txt": `${greeting}\n`,
      "repo/docs/Home.md": `The docs.\n\nGreetings say ${greeting}\n`,
    },
    commits: [["-am", message]],
    output: { outcome: "done", summary: message },
  };
}

/** The fresh read-only security assessment of the merged result. */
function securityTurn() {
  return { output: { summary: "No security finding", security: null } };
}

/** A writable Reviewer session with no additional edits. */
function hardeningTurn() {
  return { output: { outcome: "done", summary: "Hardened the change" } };
}

/**
 * The issue's saved state, read from its state comment.
 * @param {import("./pipeline-flow-gh-world.mjs").World} world
 * @param {number} [issueNumber]
 * @returns {any}
 */
function savedState(world, issueNumber = ISSUE) {
  const comment = world.comments
    .filter(
      ({ issue, body, login }) =>
        issue === issueNumber && login === world.account && STATE.test(body),
    )
    .at(-1);
  const { json } = STATE.exec(comment?.body ?? "")?.groups ?? {};
  if (json === undefined) {
    throw new Error(`#${issueNumber} has no state comment`);
  }
  return JSON.parse(json);
}

export {
  authorTurn,
  hardeningTurn,
  implementorTurn,
  openFlowIssue,
  retainAuthoredIssue,
  savedState,
  securityTurn,
};
