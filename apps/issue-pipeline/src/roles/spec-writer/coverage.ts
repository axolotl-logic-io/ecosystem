// The spec writer's interface coverage check: which Behaviour items of a spec
// no test interface covers. A Behaviour item is a top-level list item of the
// section, with its nested sub-bullets folded into it. An interface covers an
// item when one of its `behaviours` quotes the item's own text, or its text
// with its sub-bullets: the two are equal once markdown (backticks, `*`, `_`,
// `~` and link brackets) and every whitespace character are stripped from
// each. Case, punctuation and wording must match (the wiki's "Coverage check
// strictness"). Pure: it reads only its arguments.

import { specSection } from "../../spec-sections.ts";

// The part of a test interface entry the check reads. The reply's full entry
// type fits it structurally.
interface CoveringInterface {
  behaviours: readonly string[];
}

// A Behaviour item no interface covers: its number among the section's
// top-level items, from 1, and its own text with whitespace collapsed.
interface BehaviourGap {
  number: number;
  text: string;
}

// A top-level list item: its indent, its own text with its continuation
// lines, and its nested sub-bullets' texts.
interface ListItem {
  indent: number;
  text: string;
  nested: string[];
}

// A list item's indent, its marker, `-`, `*`, `+`, `1.` or `1)`, and its text.
const LIST_ITEM = /^(?<indent>\s*)(?:[-*+]|\d+[.)])\s+(?<text>.*)$/u;
const WHITESPACE = /\s+/gu;
// A markdown link or image, `[text](target)`, whose text is kept.
const LINK = /!?\[(?<text>[^\]]*)\]\([^)]*\)/gu;
const MARKDOWN = /[`*_~]/gu;

function normalised(text: string): string {
  return text.trim().replace(WHITESPACE, " ");
}

// What a quote and an item are compared by: the text without markdown and
// without whitespace.
function compared(text: string): string {
  return text
    .replace(LINK, "$<text>")
    .replace(MARKDOWN, "")
    .replace(WHITESPACE, "");
}

// The top-level items of a list's lines, each with its continuation lines
// joined on and its nested items folded in. An item nests when it is indented
// more than the top-level item before it. A blank line ends an item's
// continuation lines, but a nested item after it still folds into its parent.
function listItems(lines: readonly string[]): ListItem[] {
  const items: ListItem[] = [];
  let current: ListItem | null = null;
  let continuing = false;
  for (const line of lines) {
    const { indent, text } = LIST_ITEM.exec(line)?.groups ?? {};
    if (indent !== undefined && text !== undefined) {
      if (current !== null && indent.length > current.indent) {
        current.nested.push(text);
      } else {
        current = { indent: indent.length, text, nested: [] };
        items.push(current);
      }
      continuing = true;
    } else if (line.trim() === "") {
      continuing = false;
    } else if (current !== null && continuing) {
      continued(current, line);
    }
  }
  return items;
}

// Joins continuation `line` onto `item`'s last nested item, or onto its own
// text when it has none.
function continued(item: ListItem, line: string): void {
  const last = item.nested.length - 1;
  if (last >= 0) {
    item.nested[last] = `${item.nested[last]} ${line}`;
  } else {
    item.text = `${item.text} ${line}`;
  }
}

// The Behaviour items of `spec` no entry of `interfaces` quotes, in spec
// order, each once; empty when every item is covered.
function behaviourGaps(
  spec: string,
  interfaces: readonly CoveringInterface[],
): BehaviourGap[] {
  const [, ...lines] = specSection(spec, "Behaviour");
  const quoted = new Set(
    interfaces.flatMap((entry) => entry.behaviours.map(compared)),
  );
  const seen = new Set<string>();
  const gaps: BehaviourGap[] = [];
  for (const [index, item] of listItems(lines).entries()) {
    const own = compared(item.text);
    const whole = compared([item.text, ...item.nested].join(" "));
    if (own !== "" && !seen.has(own)) {
      seen.add(own);
      if (!(quoted.has(own) || quoted.has(whole))) {
        gaps.push({ number: index + 1, text: normalised(item.text) });
      }
    }
  }
  return gaps;
}

// The Behaviour items of `spec` that no entry of `interfaces` quotes, each
// its own text with whitespace collapsed, in spec order; empty when every
// item is covered.
function interfaceGaps(
  spec: string,
  interfaces: readonly CoveringInterface[],
): string[] {
  return behaviourGaps(spec, interfaces).map((gap) => gap.text);
}

export type { BehaviourGap, CoveringInterface };
export { behaviourGaps, interfaceGaps };
