// @ts-check
// The guards the orchestrator's snapshot reads issues through
// (src/orchestrator/open-issues.ts, src/github.ts): it lists no issue while gh
// acts as another account than the config's, and an issue's author counts
// only on allowedUsers (or as the account) and while still a collaborator.
// These replace the sweep op's account and author refusals
// (ops-sweep.test.mjs), which went with the sweep. The rest of the sweep's
// tests (ops-sweep, ops-sweep-named and ops-sweep-test-kit) are retired with
// it; their invariants now hold in the orchestrator's plan:
// - candidates sorted, skipped or parked, and new work off: orchestrator.test
//   "each stage starts, later stages first, then older issues" and "stop
//   labels, merged, split, skipLabels, untrusted authors, done, live jobs and
//   new work off get no decision";
// - another live lane's hold and an open prerequisite: "an open prerequisite
//   in the after mark holds, and another lane's live lease holds";
// - an unanswered question parks the issue: "needs-info holds while the input
//   is the one asked on, and the author starts once it changes";
// - claimCandidates' oldest-first cut: "starts past maxJobs hold at the
//   global cap, counting live jobs" and "starts past a stage's cap hold…";
// - split parents' reservations: orchestrator-tick.test "a split parent whose
//   sub-issues are closed, one merged, is closed";
// - a stopped issue taken only on request (takeStopped, #251): a stop label
//   holds the issue (above), and "a stopped issue whose stop label is gone
//   starts at the stage it stopped in"; there are no named runs, the
//   orchestrator takes only --config, --brain-path and --once
//   (src/orchestrator/args.ts);
// - a named issue that isn't open: ops-claim.test "a claim refuses an issue
//   that isn't open".
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeGh } from "./fake-gh.mjs";
import "./isolated-root-test-kit.mjs";

// src, and the config kit that loads it, after the kit set a temporary root.
const { openIssues } = await import("../src/orchestrator/open-issues.ts");
const { isAllowedUser } = await import("../src/github.ts");
const { testConfig } = await import("./config-test-kit.mjs");

const gh = installFakeGh();
const { cfg } = testConfig({ allowedUsers: ["owner", "lapsed"] });
const OTHER_ACCOUNT =
  /gh is logged in as mallory, but the config's account is pipeline-bot/u;

test("openIssues lists nothing, and sets up nothing, while gh is logged in as another account", () => {
  gh.reply([{ when: "api user", stdout: "mallory\n" }]);
  assert.throws(() => openIssues(cfg), OTHER_ACCOUNT);
  assert.deepEqual(gh.calls(), [["api", "user", "--jq", ".login"]]);
});

test("an author counts only on allowedUsers or as the account, and while a collaborator", () => {
  gh.reply([{ when: "collaborators/lapsed", code: 1, keep: true }]);
  const allowed = ["owner", "pipeline-bot", "lapsed", "eve", "", null].map(
    (login) => [login, isAllowedUser(cfg, login)],
  );
  assert.deepEqual(allowed, [
    ["owner", true],
    ["pipeline-bot", true],
    ["lapsed", false],
    ["eve", false],
    ["", false],
    [null, false],
  ]);
  // A login off allowedUsers costs no collaborator lookup.
  const lookups = gh.calls().map((args) => args.join(" "));
  assert.deepEqual(lookups, [
    "api repos/example/repo/collaborators/owner --silent",
    "api repos/example/repo/collaborators/pipeline-bot --silent",
    "api repos/example/repo/collaborators/lapsed --silent",
  ]);
});
