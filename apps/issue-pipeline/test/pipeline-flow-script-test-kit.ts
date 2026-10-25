// The full-flow tests' scripting: the issue a flow starts from, the model
// turns the fake pi plays, and the issue's saved state as its state comment
// on the fake GitHub holds it.
import type { IssueState } from "../src/state.ts";
import { newIssueState } from "../src/state.ts";
import { openIssue } from "./fake-pipeline-flow-gh.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import { withWorld } from "./fake-pipeline-flow-gh-world.ts";
import { seedReleasedRun } from "./pipeline-flow-coordination-test-kit.ts";
import type { Flow } from "./pipeline-flow-test-kit.ts";
import { ISSUE } from "./pipeline-flow-test-kit.ts";

const STATE =
  /^(?:\*\*🤖 issue-pipeline · state\*\*\n)?<!-- agent-pipeline:state\n(?<json>[\s\S]*?)\n-->/u;

// Opens the flow's issue on the fake GitHub.
function openFlowIssue(
  flow: Flow,
  login: string,
  title: string,
  body: string,
): void {
  openIssue(flow.ghDir, { number: ISSUE, title, body, login });
}

//  A saved pre-optional-Author run, without a mode marker.
function retainAuthoredIssue(flow: Flow): void {
  const {
    authorUsed: _mode,
    requirementsInputs: _inputs,
    ...saved
  } = newIssueState(ISSUE, "author");
  withWorld(flow.ghDir, (world) => {
    const execution = seedReleasedRun(world, ISSUE, `agent/issue-${ISSUE}`);
    world.comments.push({
      id: world.nextId,
      issue: ISSUE,
      login: world.account,
      createdAt: "2026-10-18T00:00:00Z",
      updatedAt: "2026-10-18T00:00:00Z",
      body: `<!-- agent-pipeline:state\n${JSON.stringify({ ...saved, execution })}\n-->`,
    });
    world.nextId += 1;
  });
}

// The author's turn that writes `gherkin`.
function authorTurn(
  gherkin: string,
  changed: boolean,
): {
  output: {
    outcome: string;
    gherkin: string;
    assumptions: never[];
    changed: boolean;
  };
} {
  return {
    output: {
      outcome: "gherkin",
      gherkin,
      assumptions: [],
      changed,
    },
  };
}

// An implementor's turn that writes the greeting and the docs' word on it,
// commits them through pipeline_commit and replies done.
function implementorTurn(
  greeting: string,
  message: string,
): {
  files: { "repo/greet.txt": string; "repo/docs/Home.md": string };
  commits: string[][];
  output: { outcome: string; summary: string };
} {
  return {
    files: {
      "repo/greet.txt": `${greeting}\n`,
      "repo/docs/Home.md": `The docs.\n\nGreetings say ${greeting}\n`,
    },
    commits: [["-am", message]],
    output: { outcome: "done", summary: message },
  };
}

//  The fresh read-only security assessment of the merged result.
function securityTurn(): { output: { summary: string; security: null } } {
  return { output: { summary: "No security finding", security: null } };
}

//  A writable Reviewer session with no additional edits.
function hardeningTurn(): { output: { outcome: string; summary: string } } {
  return { output: { outcome: "done", summary: "Hardened the change" } };
}

// The issue's saved state, read from its state comment.
function savedState(world: World, issueNumber: number = ISSUE): IssueState {
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
