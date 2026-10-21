// Required pages describe work, not whether the issue has wiki commits yet.
// Setup failures name that work without inventing a revision or authorizing a
// fallback checkout. Only signed Gherkin supplied by role-inputs is used here.

import type { Config } from "../config.ts";
import { wikiCfg } from "../config.ts";
import type { RoleContext } from "./role-context.ts";

function wikiSetupReason(pages: readonly string[], problem: string): string {
  let work = "the configured target wiki";
  if (pages.length > 0) {
    work = `required wiki updates (${pages.join(", ")})`;
  }
  return `${work}: ${problem}. Supply the enabled, accessible authoritative target wiki as docs/ using its configured submodule and base; reconcile retained checkout/recovery evidence before an explicitly authorized restart. Neither repo/ documentation nor the pipeline's prompt pages substitute for docs/. This grants no code write, repeat merge, wiki publication or completion authority`;
}

function unavailableWiki(cfg: Config): string {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return "wiki is disabled in the target configuration";
  }
  return `configured wiki.dir ${wiki.dir} is not an initialized authoritative wiki submodule (base ${wiki.branch}); correct wiki.dir and its tracked gitlink/.gitmodules configuration`;
}

function wikiRequirementHold(ctx: RoleContext): string | null {
  const pages = ctx.inputs.gherkin?.wikiPages ?? [];
  if (ctx.dirs.docs !== null || pages.length === 0) {
    return null;
  }
  return wikiSetupReason(pages, unavailableWiki(ctx.cfg));
}

export { wikiRequirementHold, wikiSetupReason };
