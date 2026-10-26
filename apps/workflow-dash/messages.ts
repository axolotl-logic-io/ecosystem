import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Selection } from "./selection.ts";

interface InstructionContext {
  ui: Pick<ExtensionContext["ui"], "editor">;
  isIdle: () => boolean;
}
type InstructionSender = Pick<ExtensionAPI, "sendUserMessage">;
const globalTemplates = [
  "pause issue delivery (set CUTOVER-HOLD per runbook)",
  "resume issue delivery per runbook",
  "status report",
  "assess ready tasks within configured resource caps per runbook; unknown resource ownership stays held",
];
/** Only edited, submitted text crosses into the caller's model context. */
async function composeInstruction(
  pi: InstructionSender,
  ctx: InstructionContext,
  text: string,
  active: () => boolean = () => true,
): Promise<boolean> {
  const edited = await ctx.ui.editor(
    "Tell the caller · edit then submit, Esc cancels",
    text,
  );
  if (!active() || edited === undefined || edited.trim() === "") {
    return false;
  }
  const options: Parameters<ExtensionAPI["sendUserMessage"]>[1] = {
    expandPromptTemplates: false,
  };
  if (!ctx.isIdle()) {
    options.deliverAs = "steer";
  }
  pi.sendUserMessage(edited.trim(), options);
  return true;
}
/** Draft instructions only; the caller decides and performs every write. */
function actionTemplates(selection: Selection | undefined): string[] {
  if (selection === undefined) {
    return [];
  }
  if (selection.kind === "buddy-run") {
    const { run, condition } = selection.entry;
    return [
      `investigate buddy run ${run.id} (${run.buddy.name}); the dashboard observed it as ${condition.state}, which is not proof of its state`,
      `assess whether buddy run ${run.id} needs a stop for its scope; a stop affects that scope only`,
    ];
  }
  if (selection.kind === "action-run") {
    const { run } = selection.entry;
    const ref = `action run ${run.id} (${run.task} on ${run.workItem.repo} #${run.workItem.number})`;
    const templates = [`investigate ${ref}`];
    if (run.outcome === "unknown" || run.checkpoint.state === "uncertain") {
      templates.push(
        `reconcile ${ref} by reading its effects; do not repeat it to get a clearer result`,
      );
    }
    return templates;
  }
  if (selection.kind === "issue" && selection.item.isPr !== true) {
    const ref = `${selection.item.repo} #${selection.item.number}`;
    return [
      `prioritize ${ref} next`,
      `hold ${ref}`,
      `file a follow-up for ${ref}`,
      `split ${ref}`,
    ];
  }
  if (selection.kind === "subagent") {
    return [
      `steer subagent run ${selection.run.id}: …`,
      `answer subagent run ${selection.run.id}'s pending request: …`,
    ];
  }
  return [];
}

export type { InstructionContext, InstructionSender };
export { actionTemplates, composeInstruction, globalTemplates };
