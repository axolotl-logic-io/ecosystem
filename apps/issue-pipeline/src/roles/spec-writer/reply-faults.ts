// What the spec writer's reply checks find in a reply (the wiki's
// Pipeline-Roles-Spec-Writer, "Reply check in the session"): a ready reply
// whose spec has no Behaviour section, or Behaviour items no interface
// covers (coverage.ts). `check-reply` gives the uncovered items whole, for
// the retry's task; the session's reply check gives compact findings, each
// item by its number and the start of its text, together with the commit
// check's git-only failures, so the session fixes them all before it ends.
// Pure: the caller runs git.

import { z } from "zod";
import { specSection } from "../../spec-sections.ts";
import type { Failure } from "./check.ts";
import type { BehaviourGap } from "./coverage.ts";
import { behaviourGaps } from "./coverage.ts";
import { specReadingOf } from "./reply.ts";

const INTERFACE = z.looseObject({
  name: z.string(),
  where: z.string(),
  status: z.enum(["existing", "new", "changed"]),
  behaviours: z.array(z.string()),
});
const READY = z.looseObject({
  spec: z.string(),
  wikiOnly: z.boolean().default(false),
  interfaces: z.array(INTERFACE),
  noTestsReason: z.string().nullable(),
});

type Ready = z.infer<typeof READY>;

const NO_BEHAVIOUR = "the spec has no Behaviour section";
// How coverage matches, for a failure that names uncovered items.
const COVERAGE_RULE =
  "An item is covered when one of an interface's `behaviours` quotes its own text, or its text with its sub-bullets; markdown and whitespace don't count.";
// How many characters of a Behaviour item a compact finding shows.
const GAP_LABEL_CHARS = 60;
// The first line of the session's reply check's findings.
const SESSION_LEAD =
  "The pipeline's checks would fail this reply. Fix these, commit with pipeline_commit, then call structured_output again:";

// Why a ready reply's spec fails before its commits are checked: it has no
// Behaviour section, or Behaviour items no interface covers; null when it
// doesn't.
type SpecFault =
  | { kind: "no-behaviour" }
  | { kind: "gaps"; gaps: BehaviourGap[] };

function specFault(ready: Ready): SpecFault | null {
  const { spec, interfaces, noTestsReason } = ready;
  if (specSection(spec, "Behaviour").length === 0) {
    return { kind: "no-behaviour" };
  }
  const gaps = behaviourGaps(spec, interfaces);
  if (noTestsReason === null && gaps.length > 0) {
    return { kind: "gaps", gaps };
  }
  return null;
}

// Why a ready reply fails before its commits are checked, or null.
function readyFault(reply: unknown): string | null {
  const parsed = READY.safeParse(reply);
  if (!parsed.success) {
    return "the ready reply has no spec or interfaces";
  }
  const fault = specFault(parsed.data);
  if (fault === null) {
    return null;
  }
  if (fault.kind === "no-behaviour") {
    return NO_BEHAVIOUR;
  }
  const list = fault.gaps.map((gap) => `- ${gap.text}`).join("\n");
  return `No test interface quotes these Behaviour items in its behaviours:\n${list}\n${COVERAGE_RULE}`;
}

// A Behaviour item as a compact finding names it: its number and the start
// of its text.
function gapLabel(gap: BehaviourGap): string {
  let { text } = gap;
  if (text.length > GAP_LABEL_CHARS) {
    text = `${text.slice(0, GAP_LABEL_CHARS)}…`;
  }
  return `${gap.number} ("${text}")`;
}

// What the reply's spec breaks, as compact findings.
function specFindings(ready: Ready): string[] {
  const fault = specFault(ready);
  if (fault === null) {
    return [];
  }
  if (fault.kind === "no-behaviour") {
    return [`- ${NO_BEHAVIOUR}`];
  }
  const labels = fault.gaps.map(gapLabel).join(", ");
  return [
    `- coverage: no interface's \`behaviours\` quotes Behaviour items ${labels}. ${COVERAGE_RULE}`,
  ];
}

// What the role's checks would fail the session's `reply` for, on an issue
// at `depth`, as compact findings under one lead line: a reply the reader
// finds bad, or a ready reply's spec faults and the commit check's git-only
// failures, which `gitFailures` gives for the ready reply. Null when there
// are none, or the reply is not a ready one.
function sessionFindings(
  reply: unknown,
  depth: number,
  gitFailures: (ready: Ready) => readonly Failure[],
): string | null {
  const reading = specReadingOf(reply, depth);
  if (reading.kind === "bad") {
    return `${SESSION_LEAD}\n- ${reading.reason}`;
  }
  if (reading.kind !== "ready") {
    return null;
  }
  const ready = READY.parse(reading.reply);
  const findings = [
    ...specFindings(ready),
    ...gitFailures(ready).map(
      (failure) => `- ${failure.rule}: ${failure.reason}`,
    ),
  ];
  if (findings.length === 0) {
    return null;
  }
  return [SESSION_LEAD, ...findings].join("\n");
}

export type { Ready };
export { READY, readyFault, sessionFindings };
