// The Gherkin task app (#249), on the task app framework (task-app/):
//
//   node gherkin.mjs --config BUDDY_FILE --issue OWNER/REPO#N
//
// Only `start:gherkin` starts it. Its work is one read-only session
// (task-app/session.ts) that writes the issue's behaviour as Gherkin, or
// asks the questions only the issue's author can answer, and returns either
// through structured output. The app posts the reply: Gherkin as the
// issue's one Gherkin comment, which a later run finds by its hidden marker
// and edits in place, and questions as a new comment each time.
import { gherkinReply } from "@ecosystem/gherkin/reply";
import { loadConfig } from "./config.ts";
import { readOnlySession } from "./task-app/session.ts";
import { main, type TaskRun } from "./task-app/task-app.ts";

const TASK = "gherkin";
const GHERKIN_KIND = "gherkin";
const QUESTIONS_KIND = "questions";
// The session's facts beside the issue file: where the current Gherkin is,
// and the reply's two shapes.
const FACTS: readonly string[] = [
  "## Current Gherkin",
  "",
  "The issue's current Gherkin, if it has one, is the comment of the pipeline's `gherkin` task in the issue file.",
  "",
  "## Reply",
  "",
  "- `gherkin`: the behaviour as one Feature in `gherkin`, and your calls in `assumptions`.",
  `- \`needs-info\`: up to 5 \`questions\` that only the issue's author can answer.`,
  "",
];

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function gherkinBody(gherkin: string, assumptions: readonly string[]): string {
  const lines = ["## Behaviour", "", "```gherkin", gherkin.trim(), "```"];
  if (assumptions.length > 0) {
    lines.push("", "### Assumptions", "", ...bullets(assumptions));
  }
  lines.push(
    "",
    `<sub>Written by the pipeline's \`${TASK}\` task. To change the behaviour, say so on the issue and apply \`start:${TASK}\` again.</sub>`,
  );
  return lines.join("\n");
}

function questionsBody(questions: readonly string[]): string {
  return [
    "## Questions for the issue's author",
    "",
    `The \`${TASK}\` task can't write this issue's behaviour without these answers. Answer them on the issue, then apply \`start:${TASK}\` again.`,
    "",
    ...bullets(questions),
  ].join("\n");
}

async function work(run: TaskRun): Promise<void> {
  const cfg = loadConfig(run.config);
  const reply = await readOnlySession(run, cfg, {
    agent: "issue-pipeline-gherkin",
    page: "gherkin.md",
    profile: "gherkin",
    facts: FACTS,
    schema: gherkinReply,
  });
  const payload = { run: run.run };
  if (reply.outcome === "needs-info") {
    run.comment(questionsBody(reply.questions), QUESTIONS_KIND, payload);
    return;
  }
  const body = gherkinBody(reply.gherkin, reply.assumptions);
  const earlier = run.recovery.earlierComments(GHERKIN_KIND).at(-1);
  if (earlier === undefined) {
    run.comment(body, GHERKIN_KIND, payload);
    return;
  }
  run.edit(earlier.comment.id, body, GHERKIN_KIND, payload);
}

await main({ id: TASK, work });
