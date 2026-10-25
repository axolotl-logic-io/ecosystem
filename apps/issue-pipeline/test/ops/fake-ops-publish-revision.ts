// Only currentRevision is doubled. Graph gates retain real fresh PR and
// ancestry evidence, loaded after the shared fixture establishes HOME/root.
import "./ops-publish-environment-fixtures.ts";
import { z } from "zod";
import type { Config } from "../../src/config.ts";
import type { Revision } from "../../src/state.ts";

const OBSERVED = z.object({
  mergeAttempt: z.object({ result: z.string() }),
  codeMerged: z.object({ pr: z.number(), sha: z.string() }),
});

const { confirmMerged, pullRequest }: typeof import("../../src/revision.ts") =
  await import("../../src/revision.ts");

interface CurrentPr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeCommit: string | null;
  headSha: string;
}

interface CurrentRevision {
  revision: Revision;
  baseSha: string;
  pr: CurrentPr | null;
}

let answer: CurrentRevision | Error | null = null;
const seen: { n: number; state: unknown }[] = [];

function setCurrentRevision(value: CurrentRevision | Error): void {
  answer = value;
  seen.length = 0;
}

function currentRevisionCalls(): { n: number; state: unknown }[] {
  return [...seen];
}

function currentRevision(
  cfg: Config,
  n: number,
  state: unknown,
): CurrentRevision {
  seen.push({ n, state });
  if (answer === null) {
    throw new Error("the test set no current revision");
  }
  if (answer instanceof Error) {
    throw answer;
  }
  const observed = OBSERVED.safeParse(state);
  if (observed.success) {
    const pr = pullRequest(cfg, n, observed.data.codeMerged.pr);
    return {
      ...answer,
      pr,
      baseSha: observed.data.codeMerged.sha,
      revision: { ...answer.revision, code: observed.data.codeMerged.sha },
    };
  }
  return answer;
}

export {
  confirmMerged,
  currentRevision,
  currentRevisionCalls,
  pullRequest,
  setCurrentRevision,
};
