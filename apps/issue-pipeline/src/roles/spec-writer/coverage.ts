// The spec writer's interface coverage check: which Behaviour items of a spec
// no test interface covers. An interface covers an item when one of its
// `behaviours` quotes the item: the two are equal once each is trimmed and
// every run of whitespace is one space. Case, punctuation and wording must
// match (the wiki's "Coverage check strictness"). Pure: it reads only its
// arguments.

import { specSection } from "../../spec-sections.ts";

// The part of a test interface entry the check reads. The reply's full entry
// type fits it structurally.
interface CoveringInterface {
  behaviours: readonly string[];
}

// A list item's marker, `-`, `*`, `+`, `1.` or `1)`, and the item's text.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?<text>.*)$/u;
const WHITESPACE = /\s+/gu;

function normalised(text: string): string {
  return text.trim().replace(WHITESPACE, " ");
}

// The items of a list's lines, nested ones included, each with its
// continuation lines joined on. A blank line ends an item.
function listItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const { text } = LIST_ITEM.exec(line)?.groups ?? {};
    if (text !== undefined) {
      if (current !== null) {
        items.push(current);
      }
      current = text;
    } else if (line.trim() === "") {
      if (current !== null) {
        items.push(current);
      }
      current = null;
    } else if (current !== null) {
      current = `${current} ${line}`;
    }
  }
  if (current !== null) {
    items.push(current);
  }
  return items;
}

// The Behaviour items of `spec`, normalised, each once, in spec order.
function behaviourItems(spec: string): string[] {
  const [, ...lines] = specSection(spec, "Behaviour");
  const items = listItems(lines).map(normalised);
  return [...new Set(items.filter((item) => item !== ""))];
}

// The Behaviour items of `spec` that no entry of `interfaces` quotes,
// normalised, in spec order; empty when every item is covered.
function interfaceGaps(
  spec: string,
  interfaces: readonly CoveringInterface[],
): string[] {
  const quoted = new Set(
    interfaces.flatMap((entry) => entry.behaviours.map(normalised)),
  );
  return behaviourItems(spec).filter((item) => !quoted.has(item));
}

export type { CoveringInterface };
export { interfaceGaps };
