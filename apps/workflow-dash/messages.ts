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
function actionTemplates(selection: Selection | undefined): string[] {
  if (selection === undefined) {
    return [];
  }
  if (selection.kind === "workflow") {
    const { run } = selection;
    let ref = `${run.repo} #${run.issue}`;
    if (run.data.id !== undefined) {
      ref += ` · run ${run.data.id}`;
    }
    return [
      `assess a retry as a new linked run for ${ref} from its latest kept checkpoint at source stage ${run.data.stage}; preserve task/binding attempt budgets and reconcile uncertain writes first`,
      `investigate this workflow run: ${ref}`,
      `assess a retry as a new linked run after timeout: ${ref}; reconcile uncertain writes before retrying`,
    ];
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
  if (selection.kind === "buddy") {
    return [
      `steer buddy run ${selection.run.id}: …`,
      `answer buddy run ${selection.run.id}'s pending request: …`,
      `assess replacing buddy run ${selection.run.id} with a new linked run; reconcile uncertain writes first`,
    ];
  }
  return [];
}

export type { InstructionContext, InstructionSender };
export { actionTemplates, composeInstruction, globalTemplates };
