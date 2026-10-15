// The split op: opens triage's sub-issues under the issue, each after the
// earlier ones it names, and parks the issue at agent:split until they merge.

import { z } from "zod";
import { removeWorktree } from "../checkouts.ts";
import { closeClaims } from "../claims.ts";
import type { Author } from "../comments.ts";
import { AUTHOR, comment, signed } from "../comments.ts";
import type { Config } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { LABELS, setLabels } from "../labels.ts";
import { writeState } from "../state.ts";

const SUB_ISSUE = z.looseObject({
  // Indexes of earlier sub-issues in this split that must merge first.
  after: z.array(z.number()).nullish(),
  body: z.string(),
  title: z.string(),
});

const SPLIT_REQUEST = z.looseObject({
  by: AUTHOR.nullish(),
  number: z.number(),
  state: z.record(z.string(), z.unknown()).nullish(),
  subIssues: z.array(SUB_ISSUE).nullish(),
});

const DEPTH = z.number().nullish();

// The issue GitHub made: its id for the sub-issue link, its number for people.
const CREATED = z.looseObject({ id: z.number(), number: z.number() });

type SplitRequest = z.infer<typeof SPLIT_REQUEST>;
type SubIssue = z.infer<typeof SUB_ISSUE>;

interface Parent {
  author: Author;
  depth: number;
  n: number;
}

// Who signs the sub-issues and the summary: the agent the workflow names, or
// triage.
function authorOf(by: SplitRequest["by"]): Author {
  if (by === undefined || by === null) {
    return { role: "triage" };
  }
  return by;
}

// The line naming the sub-issues that must merge first, with its hidden mark.
function afterLine(deps: readonly number[]): string {
  if (deps.length === 0) {
    return "";
  }
  const named = deps.map((dep) => `#${dep}`).join(", ");
  return `\nAfter ${named} merges.\n<!-- agent-pipeline:after ${deps.join(",")} -->`;
}

// Opens one sub-issue, links it under the parent, and returns its number.
function openSubIssue(
  cfg: Config,
  parent: Parent,
  sub: SubIssue,
  created: readonly number[],
): number {
  const deps = (sub.after ?? []).flatMap((index) => created[index] ?? []);
  const body = signed(
    parent.author,
    `${sub.body}\n\nPart of #${parent.n}.${afterLine(deps)}\n\n<!-- agent-pipeline:parent ${parent.n} depth ${parent.depth} -->`,
  );
  const issue = CREATED.parse(
    ghJson(cfg, [
      "api",
      "-X",
      "POST",
      `repos/${cfg.repo}/issues`,
      "-f",
      `title=${sub.title}`,
      "-f",
      `body=${body}`,
    ]),
  );
  gh(
    cfg,
    [
      "api",
      "-X",
      "POST",
      `repos/${cfg.repo}/issues/${parent.n}/sub_issues`,
      "-F",
      `sub_issue_id=${issue.id}`,
      "--silent",
    ],
    { allowFail: true },
  );
  return issue.number;
}

function split(cfg: Config, request: unknown): { created: number[] } {
  const { by, number: n, state, subIssues } = SPLIT_REQUEST.parse(request);
  const { depth } = state ?? {};
  const author = authorOf(by);
  const parent = { author, depth: (DEPTH.parse(depth) ?? 0) + 1, n };
  const created: number[] = [];
  for (const sub of subIssues ?? []) {
    created.push(openSubIssue(cfg, parent, sub, created));
  }
  const list = created.map((number) => `#${number}`).join(", ");
  comment(
    cfg,
    n,
    author,
    `I split this issue into ${list}. The pipeline closes it when they have all merged.`,
  );
  writeState(cfg, n, {
    ...state,
    stage: "split",
    lease: null,
    subIssues: created,
  });
  setLabels(cfg, n, [LABELS.split.name], [LABELS.working.name]);
  closeClaims(cfg, n, "the issue was split into sub-issues.");
  removeWorktree(cfg, n);
  return { created };
}

export { split };
