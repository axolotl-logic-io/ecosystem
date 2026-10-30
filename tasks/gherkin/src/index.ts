import type {
  DomainOutcome,
  ExecutionContext,
  TaskDefinition,
} from "@ecosystem/task-framework";
import { z } from "zod";
import { gherkinReply } from "./reply.ts";

const gherkinInputs = z.strictObject({
  issue: z.strictObject({
    repository: z.string().min(1),
    number: z.number().int().positive(),
    context: z.string().min(1),
  }),
  baseBranch: z.string().min(1),
  model: z.string().min(1),
});
type GherkinInputs = z.infer<typeof gherkinInputs>;
type GherkinReply = z.infer<typeof gherkinReply>;

// The host grants read access to one revision, never Git write authority.
interface ReadOnlyRepository {
  directory: string;
  revision: string;
}
interface GherkinSession {
  inputs: GherkinInputs;
  repository: ReadOnlyRepository;
  facts: readonly string[];
}
interface GherkinCapabilities {
  openRepository: () => Promise<ReadOnlyRepository>;
  runModel: (session: GherkinSession) => Promise<unknown>;
}

const FACTS: readonly string[] = [
  "## Current Gherkin",
  "",
  "The issue's current Gherkin, if it has one, is the comment of the pipeline's `gherkin` task in the issue file.",
  "",
  "## Reply",
  "",
  "- `gherkin`: the behaviour as one Feature in `gherkin`, and your calls in `assumptions`.",
  "- `needs-info`: up to 5 `questions` that only the issue's author can answer.",
  "",
];

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function gherkinBody(feature: string, assumptions: readonly string[]): string {
  const lines = ["## Behaviour", "", "```gherkin", feature.trim(), "```"];
  if (assumptions.length > 0) {
    lines.push("", "### Assumptions", "", ...bullets(assumptions));
  }
  lines.push(
    "",
    "<sub>Written by the pipeline's `gherkin` task. To change the behaviour, say so on the issue and apply `start:gherkin` again.</sub>",
  );
  return lines.join("\n");
}

function questionsBody(questions: readonly string[]): string {
  return [
    "## Questions for the issue's author",
    "",
    "The `gherkin` task can't write this issue's behaviour without these answers. Answer them on the issue, then apply `start:gherkin` again.",
    "",
    ...bullets(questions),
  ].join("\n");
}

async function run(
  inputs: GherkinInputs,
  capabilities: GherkinCapabilities,
  context: ExecutionContext,
): Promise<DomainOutcome<GherkinReply>> {
  context.checkCancelled();
  const repository = await capabilities.openRepository();
  context.checkCancelled();
  const reply = gherkinReply.parse(
    await capabilities.runModel({ inputs, repository, facts: FACTS }),
  );
  context.checkCancelled();
  if (reply.outcome === "needs-info") {
    await context.artifacts.publish(
      "questions",
      questionsBody(reply.questions),
    );
    return { status: "needs-input", result: reply };
  }
  await context.artifacts.publish(
    "gherkin",
    gherkinBody(reply.gherkin, reply.assumptions),
  );
  return { status: "completed", result: reply };
}

const gherkin: TaskDefinition<
  GherkinInputs,
  GherkinCapabilities,
  GherkinReply
> = {
  id: "gherkin",
  inputs: gherkinInputs,
  run,
};

export type {
  GherkinCapabilities,
  GherkinInputs,
  GherkinReply,
  GherkinSession,
  ReadOnlyRepository,
};
export { gherkin, gherkinInputs };
