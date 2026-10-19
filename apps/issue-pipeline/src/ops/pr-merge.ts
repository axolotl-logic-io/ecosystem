// GitHub's actual PR target and merge metadata, validated on every read.
import { z } from "zod";
import type { Config } from "../config.ts";
import { ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { assertPrBase } from "../pr-authority.ts";

// gh's answer to the PR view.
const PR_VIEW = z.looseObject({
  url: z.string().url(),
  number: z.number().int().positive(),
  isCrossRepository: z.boolean(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  mergeCommit: z.looseObject({ oid: z.string() }).nullish(),
  state: z.string(),
});
const PR_VIEW_FIELDS =
  "number,isCrossRepository,baseRefName,headRefName,headRefOid,state,mergeable,mergeStateStatus,isDraft,mergeCommit,url";

type PrView = z.infer<typeof PR_VIEW>;

function viewForMerge(cfg: Config, pr: number): PrView {
  const view = PR_VIEW.parse(
    ghJson(cfg, "merge", [
      "pr",
      "view",
      String(pr),
      "-R",
      cfg.repo,
      "--json",
      PR_VIEW_FIELDS,
    ]),
  );
  if (
    view.number !== pr ||
    view.isCrossRepository ||
    view.url.toLowerCase() !==
      `https://github.com/${cfg.repo}/pull/${pr}`.toLowerCase()
  ) {
    throw new OpsError(`PR #${pr} is not the configured repository source PR`);
  }
  assertPrBase(cfg, pr, view.baseRefName);
  return view;
}

export type { PrView };
export { viewForMerge };
