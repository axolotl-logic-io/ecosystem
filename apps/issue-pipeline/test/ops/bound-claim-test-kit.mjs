// @ts-check
import { executionFixture } from "../execution-runtime-test-kit.mjs";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { issueReply } from "../ops-claim-test-kit.mjs";
import { configWith, fakeGh, timeless } from "../ops-cli-test-kit.mjs";

/** @import { GhReply } from '../fake-gh.mjs' */
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
    claimBound: (cfg = fixture.cfg) =>
      boundClaim(cfg, {
        number: issue,
        lane: cfg.execution?.lane,
        sweepId: "s1",
      }),
    queue: /** @param {readonly GhReply[]} replies */ (replies) =>
      fakeGh.reply(replies),
    normalizedWrites: () => fixture.writes().map((args) => args.map(timeless)),
  };
}

export { boundFixture };
