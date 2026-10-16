// An issue's flows: whether its work changes code, the wiki, both or
// neither, and what that means for its PR. Pure: the ops replies say what
// changed (`codeChanged`, `wikiAhead`), and this module alone decides what
// follows from it.

// Whether the issue's code branch changes files against its base branch, and
// whether its wiki checkout has commits the wiki lacks.
interface Flows {
  code: boolean;
  wiki: boolean;
}

// What an issue's PR needs after a push or rebase: stop (nothing changed),
// close the draft (the change lives only in the wiki), reopen it (code again
// after a wiki-only close), or nothing (go on).
type PrFlowAction = "stop" | "close" | "reopen" | "go";

function flowsOf({
  codeChanged,
  wikiAhead,
}: {
  codeChanged: boolean;
  wikiAhead: number;
}): Flows {
  return { code: codeChanged, wiki: wikiAhead > 0 };
}

// True when the issue's change lives only in the wiki.
function wikiOnly(flows: Flows | undefined): boolean {
  return flows !== undefined && !flows.code && flows.wiki;
}

function prFlowAction(flows: Flows, prClosed: boolean): PrFlowAction {
  if (flows.code) {
    if (prClosed) {
      return "reopen";
    }
    return "go";
  }
  if (!flows.wiki) {
    return "stop";
  }
  if (prClosed) {
    return "go";
  }
  return "close";
}

export type { Flows, PrFlowAction };
export { flowsOf, prFlowAction, wikiOnly };
