// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRANCH, dirtyWork, fixture } from "./adoption-test-kit.mjs";

const { withCheckout } = await import("../src/config.ts");
const { claim } = await import("../src/ops/claim.ts");
const { authorRole } = await import("../src/roles/author/author.ts");
const ISSUE = 7;
const GHERKIN_COMMENT = 123;
test("an adopted open issue restarts through normal claim and a fresh read-only author session, not legacy stage or approvals", async () => {
  const place = fixture();
  dirtyWork(place.code);
  place.adopt();
  const cfg = withCheckout(place.cfg, {
    issue: ISSUE,
    dir: place.code,
    branch: BRANCH,
  });
  const claimed = claim(cfg, {
    number: ISSUE,
    lane: "caller",
    sweepId: "restart",
  });
  assert.ok("state" in claimed);
  assert.equal(claimed.state.stage, "author");
  /** @type {import("../src/job/role-context.ts").SessionSpec[]} */
  const sessions = [];
  /** @type {import("../src/job/role-context.ts").RoleContext} */
  const ctx = {
    cfg,
    issue: ISSUE,
    stage: "author",
    state: claimed.state,
    dirs: { job: place.tmp, repo: place.code, docs: null },
    issueFile: claimed.issueFile,
    mergeQueue: null,
    inputs: {
      issue: claimed.issue,
      comments: claimed.comments,
      revision: "fresh-inputs",
      gherkin: null,
    },
    op: () => Promise.reject(new Error("author has no ops")),
    session: (spec) => {
      sessions.push(spec);
      return Promise.resolve({
        ok: true,
        reply: {
          outcome: "gherkin",
          gherkin: "Feature: Retained work\n  Scenario: explicit follow-up",
          assumptions: [],
          wikiPages: [],
          changed: true,
        },
      });
    },
    post: () => Promise.resolve(GHERKIN_COMMENT),
    save: () => Promise.resolve(),
  };
  const end = await authorRole(ctx);
  assert.ok(end.kind === "next");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.commits, false);
  assert.equal(end.state.stage, "implement");
  assert.equal(end.state.hardened, null);
  assert.equal(end.state.security, null);
  assert.equal(end.state.gherkin?.commentId, GHERKIN_COMMENT);
});
