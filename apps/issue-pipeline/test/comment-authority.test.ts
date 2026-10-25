// Current body and edit provenance, never copied markers, authorize state/claims.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commentLines, githubComment, installFakeGh } from "./fake-gh.ts";
import "./isolated-root-test-kit.ts";

const { testConfig }: typeof import("./config-test-kit.ts") = await import(
  "./config-test-kit.ts"
);
const { COMMENT, listComments }: typeof import("../src/comments.ts") =
  await import("../src/comments.ts");
const { ghIsRead }: typeof import("../src/github.ts") = await import(
  "../src/github.ts"
);
const {
  readClaimState,
  readWriteState,
  stateBody,
}: typeof import("../src/saved-state.ts") = await import(
  "../src/saved-state.ts"
);
const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { trustedInputsHash }: typeof import("../src/issue-context.ts") =
  await import("../src/issue-context.ts");
const { cfg } = testConfig({
  legacyAccount: "retired-bot",
  allowedUsers: ["owner", "dev-bot", "pipeline-bot", "retired-bot"],
});
const fake = installFakeGh();
const NUMBER = 7;
const CREATED = "2026-10-18T00:00:00Z";
const EDITED = "2026-10-18T00:01:00Z";
const PROVENANCE = /provenance|reconciliation/u;
const LEGACY = /legacy pipeline state needs explicit reconciliation/u;
const state = newIssueState(NUMBER);

function stateComment(
  extra: Record<string, unknown> = {},
): ReturnType<typeof githubComment> & Record<string, unknown> {
  return {
    ...githubComment({
      id: 1,
      login: cfg.mergeAccount,
      created: CREATED,
      body: stateBody(NUMBER, state),
    }),
    ...extra,
  };
}

function comments(items: object[]): void {
  fake.reply([
    {
      when: `issues/${NUMBER}/comments?per_page`,
      stdout: commentLines(items),
      keep: true,
    },
  ]);
}

test("unedited and merge-edited state retain authority", () => {
  for (const comment of [
    stateComment(),
    stateComment({ lastEditedAt: EDITED, editor: { login: cfg.mergeAccount } }),
  ]) {
    comments([comment]);
    assert.deepEqual(readWriteState(cfg, NUMBER), state);
    assert.deepEqual(fake.writes(ghIsRead), []);
  }
});

for (const extra of [
  { lastEditedAt: EDITED, editor: { login: cfg.devAccount } },
  { lastEditedAt: EDITED, editor: { login: "owner" } },
  { lastEditedAt: EDITED, editor: null },
  { lastEditedAt: null, editor: { login: cfg.mergeAccount } },
  { lastEditedAt: undefined, editor: undefined },
]) {
  test(`tampered or incomplete edit provenance refuses all authority: ${JSON.stringify(extra)}`, () => {
    comments([
      stateComment(),
      stateComment({
        ...extra,
        id: 2,
        ...Object.fromEntries([["node_id", "comment-2"]]),
      }),
    ]);
    assert.throws(() => readWriteState(cfg, NUMBER), PROVENANCE);
    assert.deepEqual(fake.writes(ghIsRead), []);
  });
}

test("removing markers cannot hide a development edit of merge-authored state", () => {
  comments([
    stateComment({
      body: "marker removed",
      lastEditedAt: EDITED,
      editor: { login: cfg.devAccount },
    }),
  ]);
  assert.throws(() => listComments(cfg, NUMBER), PROVENANCE);
  assert.deepEqual(fake.writes(ghIsRead), []);
});

test("same-read GraphQL body replaces stale REST content", () => {
  const fresh = { ...state, pr: 42 };
  comments([stateComment()]);
  // A queued GraphQL answer must take precedence over the REST snapshot.
  fake.reply([
    {
      when: `issues/${NUMBER}/comments?per_page`,
      stdout: commentLines([stateComment()]),
      keep: true,
    },
    {
      when: "api graphql",
      stdout: JSON.stringify({
        data: {
          node: {
            databaseId: 1,
            body: stateBody(NUMBER, fresh),
            author: { login: cfg.mergeAccount },
            createdAt: CREATED,
            updatedAt: EDITED,
            lastEditedAt: EDITED,
            editor: { login: cfg.mergeAccount },
          },
        },
      }),
    },
  ]);
  assert.deepEqual(readWriteState(cfg, NUMBER), fresh);
});

for (const login of [cfg.devAccount, "retired-bot", "owner"]) {
  test(`copied state by @${login} never grants authority or initializes empty state`, () => {
    comments([stateComment({ user: { login } })]);
    assert.throws(
      () => readClaimState(cfg, NUMBER, listComments(cfg, NUMBER)),
      PROVENANCE,
    );
    assert.deepEqual(fake.writes(ghIsRead), []);
  });
}

test("legacy-account state requires reconciliation and never automatic adoption", () => {
  comments([stateComment({ user: { login: "retired-bot" } })]);
  assert.throws(() => readWriteState(cfg, NUMBER), LEGACY);
});

test("legacy machine text stays out of trusted inputs without making bots human", () => {
  fake.reply([
    { when: "collaborators/owner", stdout: "", keep: true },
    { when: "collaborators/retired-bot", stdout: "", keep: true },
  ]);
  const issue = { title: "T", body: "B", user: { login: "owner" } };
  const base = trustedInputsHash(cfg, issue, []);
  const machine = stateComment({ user: { login: "retired-bot" } });
  assert.equal(trustedInputsHash(cfg, issue, [COMMENT.parse(machine)]), base);
});

for (const reply of [
  { stdout: "not JSON" },
  { stdout: "null" },
  { code: 1, stderr: "provenance unavailable" },
]) {
  test(`unreadable provenance query cannot grant authority: ${JSON.stringify(reply)}`, () => {
    fake.reply([
      {
        when: `issues/${NUMBER}/comments?per_page`,
        stdout: commentLines([stateComment()]),
        keep: true,
      },
      { when: "api graphql", ...reply },
    ]);
    assert.throws(() => readWriteState(cfg, NUMBER), PROVENANCE);
    assert.deepEqual(fake.writes(ghIsRead), []);
  });
}
