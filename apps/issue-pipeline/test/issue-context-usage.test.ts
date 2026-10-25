import { usageBody } from "./usage-fixtures.ts";
// issue.md leaves out the pipeline's usage comments (#459): they are its own
// records, so no agent reads one as a person's comment, while a comment by
// the bot account with no pipeline mark is withheld.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { credentialConfig } from "./credentials-test-kit.ts";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.ts";
import { setEnv } from "./ops-run-test-kit.ts";

const root = fs.mkdtempSync("/tmp/issue-pipeline-issue-context-usage-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
// The pipeline root is read once, on import, so it is set first.
setEnv("ISSUE_PIPELINE_ROOT", root);
const fakeGh = installFakeGh();
const { loadConfig }: typeof import("../src/config.ts") = await import(
  "../src/config.ts"
);
const { writeIssueContext }: typeof import("../src/issue-context.ts") =
  await import("../src/issue-context.ts");

const ACCOUNT = "bot";
const ALLOWED = "alice";
const ISSUE = 9;
const AT = "2026-10-18T08:02:00Z";
const RECORD = '{"kind":"job","issue":9,"role":"triage"}';

const configFile = path.join(root, "config.json");
fs.writeFileSync(
  configFile,
  JSON.stringify({
    repo: "o/r",
    ...credentialConfig(ACCOUNT),
    allowedUsers: [ALLOWED],
    baseBranch: "integration",
    commands: { test: "true" },
  }),
);
const cfg = loadConfig(configFile);

// The body of the issue's `kind` usage comment (`usage`, `usage-2`, ...), as
// src/job/usage-comment.ts lays it out.

// issue.md as writeIssueContext writes it for an issue with `comments`, each
// a [login, body] pair. The fake gh answers every collaborator check with
// success.
function issueFileWith(comments: readonly [string, string][]): string {
  const listed = comments.map(([login, body], at) =>
    githubComment({ id: at + 1, body, login, created: AT, updated: AT }),
  );
  fakeGh.reply([
    { when: "api repos/o/r/collaborators/alice", stdout: "", keep: true },
    {
      when: `issues/${ISSUE}/comments?per_page`,
      stdout: commentLines(listed),
    },
    {
      when: `repos/o/r/issues/${ISSUE}`,
      stdout: JSON.stringify({
        body: "The issue.",
        title: "A title",
        user: { login: ALLOWED },
      }),
    },
  ]);
  const { file } = writeIssueContext(cfg, ISSUE);
  return fs.readFileSync(file, "utf8");
}

test("issue.md leaves out the account's usage comments (#459)", () => {
  const text = issueFileWith([
    [ACCOUNT, usageBody(ISSUE, "usage")],
    [ACCOUNT, usageBody(ISSUE, "usage-2")],
  ]);
  assert.ok(!text.includes(`issue-pipeline:${ISSUE}:usage`), text);
  assert.ok(!text.includes(RECORD), text);
  assert.ok(!text.includes("(a person)"), text);
  assert.ok(!text.includes("withheld"), text);
});

test("issue.md withholds an unmarked bot comment rather than treating it as human input", () => {
  const text = issueFileWith([
    [ACCOUNT, usageBody(ISSUE, "usage")],
    [ACCOUNT, "Yes, keep the old behaviour."],
  ]);
  assert.ok(
    !text.includes(`Comment by @${ACCOUNT} (a person) at ${AT}:`),
    text,
  );
  assert.ok(!text.includes("Yes, keep the old behaviour."), text);
  assert.ok(!text.includes(RECORD), text);
});
