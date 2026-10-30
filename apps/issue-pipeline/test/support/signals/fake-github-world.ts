// The JSON world file behind the signal tests' fake gh and fake task seam:
// accounts, one organization's memberships, issues with their labels,
// label events, comments and assignees, injected read faults, the POST
// outcome and the task lane's answers. The fake GitHub server
// (fake-gh-server.ts) holds it and writes it back whole after each change,
// so every process that reads the file sees GitHub's state after some
// completed call.
import fs from "node:fs";
import { z } from "zod";
import { TASK_RESULT } from "../../../src/domain.ts";

const MAX_EXIT_CODE = 255;
const CHECK_REPLY = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  code: z.number().int().min(0).max(MAX_EXIT_CODE),
  afterComment: z.array(z.string()).min(1).optional(),
  moveHeadTo: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .optional(),
});

const ACCOUNT = z.strictObject({
  login: z.string(),
  id: z.number().int().positive(),
  type: z.string(),
});
const MEMBER = z.strictObject({
  login: z.string(),
  state: z.enum(["active", "pending"]),
  role: z.string(),
});
const EVENT = z.strictObject({
  id: z.number().int().positive(),
  event: z.string(),
  label: z.string().nullable(),
  actor: z.string().nullable(),
  // The user id the event reports for its actor, when it isn't the
  // account's current one, as for a login GitHub since reassigned.
  actorId: z.number().int().positive().optional(),
  viaApp: z.boolean(),
  createdAt: z.string(),
});
const COMMENT = z.strictObject({
  id: z.number().int().positive(),
  author: z.string(),
  body: z.string(),
  editor: z.string().nullable(),
  createdAt: z.string(),
});
// A submitted review of a pull request, by an account's login, against the
// head commit `commitId`.
const REVIEW = z.strictObject({
  id: z.number().int().positive(),
  author: z.string(),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  commitId: z.string(),
  body: z.string(),
  submittedAt: z.string(),
});
// A comment on a pull request's lines: a thread's first comment names its
// review; a reply names the comment it answers.
const REVIEW_COMMENT = z.strictObject({
  id: z.number().int().positive(),
  review: z.number().int().positive().nullable(),
  inReplyTo: z.number().int().positive().nullable(),
  author: z.string(),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  commitId: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
// A pull request, as the buddy flow tests' fake gh keeps it. Its head
// commit is always its head branch's tip in the origin. `mergeCommit` is the
// merge commit `gh pr merge --merge` made; `mergeable` overrides what the
// origin's own merge of head into base says.
const PULL = z.strictObject({
  number: z.number().int().positive(),
  head: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  reviews: z.array(REVIEW).optional(),
  reviewComments: z.array(REVIEW_COMMENT).optional(),
  mergeCommit: z.string().optional(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).optional(),
});
const ISSUE = z.strictObject({
  number: z.number().int().positive(),
  // The issue's own text and author, which the task lane's trusted
  // requirements read; the signal tests leave them out.
  title: z.string().optional(),
  body: z.string().optional(),
  author: z.string().optional(),
  pullRequest: z.boolean(),
  labels: z.array(z.string()),
  events: z.array(EVENT),
  comments: z.array(COMMENT),
  // Who closed the issue and with which state reason (`gh issue close`);
  // an issue without it is open.
  closed: z.strictObject({ by: z.string(), reason: z.string() }).optional(),
  // The logins assigned to the issue, in the order they were added; an
  // issue without it has none.
  assignees: z.array(z.string()).optional(),
});
// An injected answer for one listing page or read: `path` without its query.
const FAULT = z.strictObject({
  path: z.string(),
  page: z.number().int().positive().nullable(),
  status: z.number().int(),
  link: z.string().nullable(),
});
// The task lane's answers, in the subset of the contract's shapes the
// signal tests use: Author and Implement requirements bindings, revision
// bindings of the other tasks, and no stored results.
const WORK_ITEM = z.strictObject({
  repo: z.string(),
  number: z.number().int().positive(),
});
const TARGET = z.strictObject({ branch: z.string(), commit: z.string() });
const BINDING = z.union([
  z.strictObject({
    workItem: WORK_ITEM,
    task: z.enum(["author", "implement"]),
    target: TARGET,
    requirements: z.string(),
  }),
  z.strictObject({
    workItem: WORK_ITEM,
    task: z.enum(["verify", "fix", "land", "refactor-safely"]),
    target: TARGET,
    revision: z.strictObject({
      code: z.string(),
      inputs: z.string(),
      policy: z.string(),
    }),
  }),
]);
const TASK_ANSWERS = z.strictObject({
  number: z.number().int().positive(),
  view: z.strictObject({
    workItem: WORK_ITEM,
    requirements: z.string(),
    revision: z.null(),
    target: TARGET,
    containsTarget: z.boolean(),
    results: z.array(TASK_RESULT),
    hold: z.string().nullable(),
    permissions: z.strictObject({ land: z.boolean() }),
  }),
  causes: z.array(
    z.strictObject({
      binding: BINDING,
      cause: z.strictObject({
        signal: z.string(),
        recordId: z.number().int().positive(),
      }),
    }),
  ),
  previous: z.string().nullable(),
  machine: z.array(
    z.strictObject({
      kind: z.literal("result"),
      id: z.string(),
      workItem: WORK_ITEM,
      binding: BINDING,
      recordId: z.number().int().positive(),
      producerRun: z.string(),
    }),
  ),
  failure: z.string().nullable(),
});
const WORLD = z.strictObject({
  repo: z.string(),
  organization: z.string(),
  // Whether membership answers include the optional `organization` object.
  organizationObject: z.boolean(),
  tokens: z.array(z.strictObject({ token: z.string(), login: z.string() })),
  accounts: z.array(ACCOUNT),
  members: z.array(MEMBER),
  issues: z.array(ISSUE),
  faults: z.array(FAULT),
  pageSize: z.number().int().positive(),
  // What a comment POST does: applies and answers, applies but loses the
  // answer, or fails before applying.
  post: z.enum(["ok", "lost-after-apply", "lost-before-apply"]),
  nextId: z.number().int().positive(),
  tasks: z.array(TASK_ANSWERS),
  // The buddy flow tests' additions: the repository's collaborators, its
  // pull requests, the buddy process the fake stops with SIGTERM when a
  // poll's first open-issue listing is its `atPoll`th, and a concurrent
  // writer's comment that GitHub shows right after the first POST whose
  // body contains every one of `after`, and a text whose every comment
  // POST or edit fails before it applies.
  collaborators: z.array(z.string()).optional(),
  failWritesContaining: z.string().optional(),
  failPostOnceContaining: z.string().min(1).optional(),
  race: z
    .strictObject({
      after: z.array(z.string()).min(1),
      comment: z.strictObject({ author: z.string(), body: z.string() }),
    })
    .optional(),
  pulls: z.array(PULL).optional(),
  // Whether the base branch requires a PR's head to contain it before a
  // merge, as GitHub's "require branches to be up to date" protection does.
  requireUpToDate: z.boolean().optional(),
  // How many of the next `gh issue close` calls fail with a 502 before they
  // apply, as a transient GitHub outage would.
  failIssueCloses: z.number().int().positive().optional(),
  // The login whose PR thread replies GitHub refuses (HTTP 422).
  refuseRepliesBy: z.string().optional(),
  // Whether GitHub refuses every change to an issue's assignees (HTTP 422).
  refuseAssigneeChanges: z.boolean().optional(),
  // Whether GitHub refuses single-label deletions (HTTP 403).
  refuseLabelChanges: z.boolean().optional(),
  // Whether a whole-issue read, `gh api repos/O/R/issues/N` with no --jq,
  // answers with assignees that aren't a list of users.
  garbleAssignees: z.boolean().optional(),
  // The required checks GitHub reports on each head commit, as GitHub
  // Actions or another CI posts them (`gh pr checks --required`).
  checks: z
    .record(
      z.string(),
      z.array(
        z.strictObject({
          name: z.string(),
          bucket: z.enum(["pass", "fail", "pending", "skipping", "cancel"]),
        }),
      ),
    )
    .optional(),
  // Raw GitHub transport replies, including malformed/error evidence. A
  // conditional reply starts only after an actual posted comment matches.
  checksReply: CHECK_REPLY.optional(),
  // Each real required-check read consumes one admission reply. The
  // conditional effect reply above takes precedence and consumes none.
  checksSequence: z.array(CHECK_REPLY).optional(),
  // How many more reads of an issue's events leave out its newest event
  // when that is an `unlabeled` one, as GitHub's timeline can lag behind a
  // label removal.
  timelineLag: z.number().int().positive().optional(),
  stopBuddy: z
    .strictObject({
      pid: z.number().int().positive(),
      atPoll: z.number().int().positive(),
      polls: z.number().int().nonnegative(),
    })
    .optional(),
});

type World = z.infer<typeof WORLD>;
type FakeIssue = z.infer<typeof ISSUE>;
type FakeEvent = z.infer<typeof EVENT>;
type FakeComment = z.infer<typeof COMMENT>;
type FakeReview = z.infer<typeof REVIEW>;
type FakeReviewComment = z.infer<typeof REVIEW_COMMENT>;
type TaskAnswers = z.infer<typeof TASK_ANSWERS>;

function parseWorld(text: string): World {
  return WORLD.parse(JSON.parse(text));
}

function readWorld(file: string): World {
  return parseWorld(fs.readFileSync(file, "utf8"));
}

// Writes `world` to `file` in one step, a reader never seeing it half
// written, and returns it as written.
function writeWorld(file: string, world: unknown): World {
  const parsed = WORLD.parse(world);
  const next = `${file}.next`;
  fs.writeFileSync(next, `${JSON.stringify(parsed, null, 2)}\n`);
  fs.renameSync(next, file);
  return parsed;
}

export type {
  FakeComment,
  FakeEvent,
  FakeIssue,
  FakeReview,
  FakeReviewComment,
  TaskAnswers,
  World,
};
export { parseWorld, readWorld, writeWorld };
