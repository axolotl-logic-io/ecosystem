// The implementer's prompt steps that depend on the config and the checkouts:
// the commands it runs and what it does with the wiki checkout.

import type { Committer } from "../prompts.ts";
import type { StageCommands } from "./types.ts";

function isSet(text: string | null | undefined): text is string {
  return typeof text === "string" && text !== "";
}

// The configured commands the session runs, as a clause of step 3.
function commandsClause(commands: StageCommands): string {
  let clause = "";
  if (isSet(commands.test)) {
    clause += ` (\`${commands.test}\`)`;
  }
  if (isSet(commands.lint)) {
    clause += `, lint (\`${commands.lint}\`)`;
  }
  if (isSet(commands.typecheck)) {
    clause += `, and typecheck (\`${commands.typecheck}\`)`;
  }
  return clause;
}

// The step that commits the wiki updates, or "" when there is no wiki or
// the implementer runs in a stage job, where the spec writer commits them
// and the implementer only reads the wiki.
function wikiStep(wiki: string | null, committer: Committer): string {
  if (!isSet(wiki) || committer === "pipeline_commit") {
    return "";
  }
  return `5. Make the wiki updates the spec lists, and record any new design decision, in the wiki checkout: edit its pages, then commit there (\`git -C ${wiki} add -A && git -C ${wiki} commit\`, same trailer). Leave it clean too. Reviewers see those commits, and they reach the wiki when the PR merges.`;
}

export { commandsClause, wikiStep };
