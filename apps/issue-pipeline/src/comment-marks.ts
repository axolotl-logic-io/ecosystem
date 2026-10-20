// Marker syntax describes pipeline content, never authenticated identity.
import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";

const STATE_MARK = "<!-- agent-pipeline:state";
const STATE_HEADER = "**🤖 issue-pipeline · state**";
// The mark of an issue's n-th usage comment (src/job/usage-log.ts): the
// first is `usage`, the next `usage-2`, and so on.
const USAGE_MARK =
  /<!-- issue-pipeline:(?<issue>\d+):usage(?:-(?<n>[2-9]|[1-9]\d+))? -->/u;
const PIPELINE_MARK = /<!-- agent-pipeline:comment role=(?<role>[\w.:-]+) -->/u;
const PARENT_MARK =
  /<!-- agent-pipeline:parent (?<parent>\d+) depth (?<depth>\d+) -->/u;
const AFTER_MARK = /<!-- agent-pipeline:after (?<after>[\d,]+) -->/u;
const CLAIM_MARK =
  /<!-- agent-pipeline:claim lane=(?<lane>\S+) sweep=(?<sweep>\S+) -->/u;
// State must occupy the comment itself, not a quoted diagnostic or body field.
function isStateBody(body: string): boolean {
  return (
    body.startsWith(STATE_MARK) ||
    body.startsWith(`${STATE_HEADER}\n${STATE_MARK}`)
  );
}

// Historical machine text is display-only, never a human input or authority.
function isLegacyPipelineComment(
  cfg: Pick<Config, "legacyAccount">,
  item: IssueComment,
): boolean {
  if (
    cfg.legacyAccount === undefined ||
    item.user?.login.toLowerCase() !== cfg.legacyAccount.toLowerCase()
  ) {
    return false;
  }
  const body = item.body ?? "";
  return (
    isStateBody(body) ||
    PIPELINE_MARK.test(body) ||
    USAGE_MARK.test(body) ||
    CLAIM_MARK.test(body)
  );
}

export {
  AFTER_MARK,
  CLAIM_MARK,
  isLegacyPipelineComment,
  isStateBody,
  PARENT_MARK,
  PIPELINE_MARK,
  STATE_HEADER,
  STATE_MARK,
  USAGE_MARK,
};
