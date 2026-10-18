// The implementor's script checks (the wiki's Pipeline-Roles-Implementor,
// "Lifecycle"), for one run of its machine: the entry the start takes,
// whether the `implement` entry has work left (a code change on the job's
// checkout since the spec's tests, not counting the spec draft, means it
// was done), the repo's setup in the job's checkout, the implementer's
// reply's status, and the push with the flows it reports. Each answers with
// one of the machine's result names; a failed push fails its check, which
// the runner ends.

import { z } from "zod";
import { setUpCheckout } from "../../checkouts.ts";
import type { Config } from "../../config.ts";
import type { CheckEffect, Outcome } from "../../job/run-step.ts";
import type { Entry } from "../../job/runner.ts";
import { run } from "../../process.ts";
import { SPEC_DRAFT } from "../../spec-draft.ts";
import { flowsOf } from "../../workflow/flows.ts";
import type { Checks, JobEffects } from "../registry.ts";
import { fixChecks } from "./fix-checks.ts";
import { answer, guarded } from "./outcome.ts";
import { implReadingOf } from "./reply.ts";

type Payload = CheckEffect["payload"];

const START = z.looseObject({ entry: z.enum(["implement", "fix"]) });
const WORK = z.looseObject({
  specTestsSha: z.string().nullable(),
  wikiOnly: z.boolean(),
});
const PUSHED = z.looseObject({
  headSha: z.string(),
  codeChanged: z.boolean(),
  wikiAhead: z.number(),
});

// Whether the checkout at `dir` changes code since `sha`, the spec draft
// aside; false when git can't tell, such as for a sha it lacks.
function changedSince(dir: string, sha: string): boolean {
  const args = ["-C", dir, "diff", "--name-only", sha, "HEAD", "--"];
  const result = run("git", args, { allowFail: true });
  if (result.code !== 0) {
    return false;
  }
  return result.stdout
    .split("\n")
    .some((file) => file !== "" && file !== SPEC_DRAFT);
}

// `none` for a wiki-only change, `built` for a branch with a code change
// since the spec's tests, and `work` otherwise.
function implementWork(dir: string, payload: Payload): Outcome {
  const { specTestsSha, wikiOnly } = WORK.parse(payload);
  if (wikiOnly) {
    return answer("none");
  }
  if (specTestsSha !== null && changedSince(dir, specTestsSha)) {
    return answer("built");
  }
  return answer("work");
}

function replyStatus(payload: Payload): Outcome {
  const { reading } = payload;
  const read = implReadingOf(reading);
  if (read === null) {
    return answer("bad");
  }
  return answer(read.status);
}

// Pushes the issue's branch, and answers whether its work changes code,
// with the pushed head and the flows.
async function pushed(effects: JobEffects, number: number): Promise<Outcome> {
  const done = await effects.op({
    kind: "op",
    op: "push",
    payload: { number },
  });
  if (!done.ok) {
    return done;
  }
  const { headSha, codeChanged, wikiAhead } = PUSHED.parse(done.reply);
  const flows = flowsOf({ codeChanged, wikiAhead });
  let name = "none";
  if (flows.code) {
    name = "code";
  }
  return answer(name, { headSha, flows });
}

// The implementor's checks for the run from `entry`, with ops through
// `effects`, and git and the setup command in the job's checkout.
function implementorChecks(
  entry: Entry,
  effects: JobEffects,
  cfg: Config,
): Checks {
  const { issue, paths } = entry.context;
  const dir = paths.worktree;
  return {
    start: (payload: Payload) =>
      guarded(() => answer(START.parse(payload).entry)),
    "implement-work?": (payload: Payload) =>
      guarded(() => implementWork(dir, payload)),
    setup: () =>
      guarded(() => {
        setUpCheckout(cfg, issue, dir, "setup-at-implement.log");
        return answer("ok");
      }),
    "implementer-reply": (payload: Payload) =>
      guarded(() => replyStatus(payload)),
    flows: () => guarded(() => pushed(effects, issue)),
    ...fixChecks(effects, () => pushed(effects, issue)),
  };
}

export { implementorChecks };
