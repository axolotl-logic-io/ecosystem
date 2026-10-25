import type { Config } from "../../src/config.ts";
import type { ClaimWon } from "../../src/ops/claim.ts";
import type { Stage } from "../../src/stages.ts";
import { executionFixture } from "../execution-runtime-test-kit.ts";
import type { GhReply } from "../fake-gh.ts";
import { claimMutationReplies } from "../gh-mutation-fixtures.ts";
import { issueReply } from "../ops-claim-test-kit.ts";
import { configWith, fakeGh, timeless } from "../ops-cli-test-kit.ts";

const { boundClaim }: typeof import("../../src/ops/bound-claim.ts") =
  await import("../../src/ops/bound-claim.ts");

// An execution fixture plus the bound claim and helpers its tests drive.
type BoundFixture = ReturnType<typeof executionFixture> & {
  claimBound: (cfg?: Config, stage?: Stage) => ClaimWon | { waiting: "answer" };
  queue: (replies: readonly GhReply[]) => void;
  normalizedWrites: () => string[][];
};

function boundFixture(
  issue: number,
  options: {
    extra?: object;
    replies?: readonly GhReply[];
    issue?: object;
  } = {},
): BoundFixture {
  const config = configWith({
    commands: { test: "true", setup: "touch setup-ran" },
    ...options.extra,
  });
  const fixture = executionFixture(issue, {
    config,
    replies: [
      ...claimMutationReplies(issue, issue, null),
      ...(options.replies ?? []),
      { ...issueReply(issue, options.issue), keep: true },
    ],
  });
  return {
    ...fixture,
    claimBound: (
      cfg: Config = fixture.cfg,
      stage: Stage = "implement",
    ): ClaimWon | { waiting: "answer" } =>
      boundClaim(cfg, {
        number: issue,
        lane: cfg.execution?.lane,
        sweepId: "s1",
        stage,
      }),
    queue: (replies: readonly GhReply[]): void => fakeGh.reply(replies),
    normalizedWrites: (): string[][] =>
      fixture.writes().map((args) => args.map(timeless)),
  };
}

export { boundFixture };
