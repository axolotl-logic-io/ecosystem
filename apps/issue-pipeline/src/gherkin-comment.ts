// An authored issue's optional Gherkin comment: signed by the
// author, keyed `gherkin`, and edited in place on every revision, so GitHub
// keeps its history. Its mark records the revision and the trusted-inputs
// revision it was written from. The Developer and the reviewer read the
// Gherkin from here at their job's start, never from the saved state. A
// comment written while the pipeline had a wiki may also list "Wiki pages";
// that section is ignored.

import type { IssueComment } from "./comments.ts";
import { keyMark, pipelineRole } from "./comments.ts";
import type { Config } from "./config.ts";

const GHERKIN_KEY = "gherkin";
const GHERKIN_MARK =
  /<!-- issue-pipeline:gherkin rev=(?<rev>[1-9]\d*) inputs=(?<inputs>[0-9a-f]{64}) -->/u;
const GHERKIN_BLOCK = /```gherkin\n(?<gherkin>[\s\S]*?)\n```/u;

interface GherkinText {
  gherkin: string;
  assumptions: readonly string[];
}

interface GherkinComment extends GherkinText {
  id: number;
  rev: number;
  inputs: string;
}

function bulletSection(heading: string, items: readonly string[]): string[] {
  if (items.length === 0) {
    return [];
  }
  return ["", `### ${heading}`, "", ...items.map((item) => `- ${item}`)];
}

function bullets(body: string, heading: string): string[] {
  const start = body.indexOf(`### ${heading}\n`);
  if (start < 0) {
    return [];
  }
  const rest = body.slice(start).split("\n").slice(1);
  const items: string[] = [];
  for (const line of rest) {
    if (line.startsWith("- ")) {
      items.push(line.slice(2));
    } else if (line !== "") {
      break;
    }
  }
  return items;
}

// The Gherkin comment's body, before the signature and the key's mark.
function gherkinBody(
  text: GherkinText,
  revision: { rev: number; inputs: string },
): string {
  return [
    "## Behaviour",
    "",
    "```gherkin",
    text.gherkin.trim(),
    "```",
    ...bulletSection("Assumptions", text.assumptions),
    "",
    `<sub>Revision ${revision.rev}. The pipeline keeps this up to date from the issue and the comments of allowed users; reply on the issue to change it.</sub>`,
    `<!-- issue-pipeline:gherkin rev=${revision.rev} inputs=${revision.inputs} -->`,
  ].join("\n");
}

// The issue's Gherkin comment, or null when it has none. Only a comment the
// landing identity wrote with trusted editor provenance, signed by the author, with the key's mark and the
// Gherkin mark, counts: anyone can paste the marks.
function gherkinCommentOf(
  cfg: Pick<Config, "mergeAccount">,
  number: number,
  comments: readonly IssueComment[],
): GherkinComment | null {
  const mark = keyMark(number, GHERKIN_KEY);
  const found = comments.find(
    (item) =>
      pipelineRole(cfg, item) === "author" && (item.body ?? "").includes(mark),
  );
  const body = found?.body ?? "";
  const { rev, inputs } = GHERKIN_MARK.exec(body)?.groups ?? {};
  const { gherkin } = GHERKIN_BLOCK.exec(body)?.groups ?? {};
  if (
    found === undefined ||
    rev === undefined ||
    inputs === undefined ||
    gherkin === undefined
  ) {
    return null;
  }
  return {
    id: found.id,
    rev: Number(rev),
    inputs,
    gherkin,
    assumptions: bullets(body, "Assumptions"),
  };
}

export type { GherkinComment, GherkinText };
export { GHERKIN_KEY, gherkinBody, gherkinCommentOf };
