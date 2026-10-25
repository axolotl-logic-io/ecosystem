// The JSON world file behind the signal tests' fake gh and fake task seam:
// accounts, one organization's memberships, issues with their labels,
// label events and comments, injected read faults, the POST outcome and the
// task lane's answers. Each fake process reads it fresh and writes it back
// after a comment POST, so state survives across subprocesses as GitHub's
// would.
import fs from "node:fs";
import { z } from "zod";

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
// A pull request, as the buddy flow tests' fake gh keeps it.
const PULL = z.strictObject({
  number: z.number().int().positive(),
  head: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
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
});
// An injected answer for one listing page or read: `path` without its query.
const FAULT = z.strictObject({
  path: z.string(),
  page: z.number().int().positive().nullable(),
  status: z.number().int(),
  link: z.string().nullable(),
});
// The task lane's answers, in the subset of the contract's shapes the
// signal tests use: Implement requirements bindings and no stored results.
const WORK_ITEM = z.strictObject({
  repo: z.string(),
  number: z.number().int().positive(),
});
const TARGET = z.strictObject({ branch: z.string(), commit: z.string() });
const BINDING = z.strictObject({
  workItem: WORK_ITEM,
  task: z.literal("implement"),
  target: TARGET,
  requirements: z.string(),
});
const TASK_ANSWERS = z.strictObject({
  number: z.number().int().positive(),
  view: z.strictObject({
    workItem: WORK_ITEM,
    requirements: z.string(),
    revision: z.null(),
    target: TARGET,
    containsTarget: z.boolean(),
    results: z.array(z.never()),
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
  // POST fails before it applies.
  collaborators: z.array(z.string()).optional(),
  failPostsContaining: z.string().optional(),
  race: z
    .strictObject({
      after: z.array(z.string()).min(1),
      comment: z.strictObject({ author: z.string(), body: z.string() }),
    })
    .optional(),
  pulls: z.array(PULL).optional(),
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
type TaskAnswers = z.infer<typeof TASK_ANSWERS>;

function readWorld(file: string): World {
  return WORLD.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

function writeWorld(file: string, world: World): void {
  fs.writeFileSync(file, `${JSON.stringify(WORLD.parse(world), null, 2)}\n`);
}

export type { FakeComment, FakeEvent, FakeIssue, TaskAnswers, World };
export { readWorld, writeWorld };
