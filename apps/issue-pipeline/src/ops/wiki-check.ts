// The wiki-check op: checks the wiki pages an issue's wiki checkout changes,
// with no model, no network and no writes. Each link in a changed page must
// name a page on the branch, and each new page must be linked from _Sidebar or
// another page. Its checks have verify's shape, so the check fixer can take
// them as it takes failed tests.

import { z } from "zod";
import type { Config } from "../config.ts";
import { parseRequest } from "../process.ts";
import type { WikiProblem } from "../wiki-check.ts";
import { readWikiChange, wikiProblems } from "../wiki-check.ts";
import type { Check } from "./verify.ts";

// pass is true exactly when checks is empty: every check here is a failure.
interface WikiCheckReply {
  pass: boolean;
  checks: Check[];
}

const REQUEST = z.looseObject({ number: z.number().int() });

function toCheck(problem: WikiProblem): Check {
  switch (problem.kind) {
    case "broken-link":
      return {
        detail: `${problem.page} links to ${problem.target}, which is not a page on the wiki branch`,
        id: `wiki-link:${problem.page}:${problem.target}`,
        pass: false,
      };
    case "orphan":
      return {
        detail: `new page ${problem.page} is not linked from _Sidebar or any other wiki page`,
        id: `wiki-orphan:${problem.page}`,
        pass: false,
      };
    default: {
      const unhandled: never = problem;
      return unhandled;
    }
  }
}

// One failed check per problem in the issue's committed wiki changes; none
// when the repo has no wiki or the issue changed nothing in it.
function wikiCheck(cfg: Config, request: unknown): WikiCheckReply {
  const { number } = parseRequest(REQUEST, "wiki-check", request);
  const change = readWikiChange(cfg, number);
  let checks: Check[] = [];
  if (change !== null) {
    checks = wikiProblems(change).map(toCheck);
  }
  return { checks, pass: checks.length === 0 };
}

export { wikiCheck };
