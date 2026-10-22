// @ts-check
import { executionFixture } from "../execution-runtime-test-kit.mjs";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { issueReply } from "../ops-claim-test-kit.mjs";
import { configWith, fakeGh, timeless } from "../ops-cli-test-kit.mjs";

/** @import { GhReply } from '../fake-gh.mjs' */
/** @import { Config } from '../../src/config.ts' */
/** @import { Stage } from '../../src/stages.ts' */
const { boundClaim } = await import("../../src/ops/bound-claim.ts");

/** @param {number} issue @param {{extra?: object, replies?: readonly GhReply[], issue?: object}} [options] */
function boundFixture(issue, options = {}) {
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
    claimBound: /** @param {Config} [cfg] @param {Stage} [stage] */ (
      cfg = fixture.cfg,
      stage = "implement",
    ) =>
      boundClaim(cfg, {
        number: issue,
        lane: cfg.execution?.lane,
        sweepId: "s1",
        stage,
      }),
    queue: /** @param {readonly GhReply[]} replies */ (replies) =>
      fakeGh.reply(replies),
    normalizedWrites: () => fixture.writes().map((args) => args.map(timeless)),
  };
}

export { boundFixture };
