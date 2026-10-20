import { z } from "zod";
import { ISSUE_STATE } from "../state.ts";
import { wire } from "./wire.ts";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
// App actors can appear in unrelated GitHub history. Parsing their provenance
// does not map them to a configured account or make them trusted humans.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/u;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/u;
const SHA = /^[0-9a-f]{40}$/u;
const INPUT_REVISION = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const MAX_REQUESTS = 1000;
const DEFAULT_REQUESTS = 100;
const USER = z.object({ login: z.string().regex(GITHUB_LOGIN) });
const ROLE = z.enum(["development", "review"]);
const REPO = z.object({
  repo: z.string().regex(REPOSITORY),
  devAccount: z.string().regex(LOGIN),
  mergeAccount: z.string().regex(LOGIN),
  legacyAccount: z.string().regex(LOGIN).optional(),
  allowedUsers: z.array(z.string().regex(LOGIN)),
  baseBranch: z.string().min(1).default("main"),
  skipLabels: z.array(z.string()).default([]),
  takeNewWork: z.boolean().default(true),
});
const SETTINGS = z.object({
  enabled: z.literal(true),
  allowRepositories: z.array(z.string().regex(REPOSITORY)),
  repositories: z.array(REPO),
  workers: z.array(
    z.object({
      repository: z.string().regex(REPOSITORY),
      login: z.string().regex(LOGIN),
      worker: z.string().regex(IDENTIFIER),
      roles: z.array(ROLE).min(1),
      reviewer: z.string().regex(LOGIN).optional(),
    }),
  ),
  requestBudget: z
    .number()
    .int()
    .min(1)
    .max(MAX_REQUESTS)
    .default(DEFAULT_REQUESTS),
});

// REST keys are normalized before validating the domain shape.
const ISSUE = wire(
  z.object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    body: z.string().nullable(),
    user: USER,
    assignees: z.array(USER),
    labels: z.array(z.object({ name: z.string() })),
    pullRequest: z.unknown().optional(),
  }),
);
const REF = z.object({
  ref: z.string().min(1),
  sha: z.string().regex(SHA),
  repo: z.object({ fullName: z.string().regex(REPOSITORY) }),
});
const PULL = wire(
  z.object({
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    body: z.string().nullable(),
    user: USER,
    head: REF,
    base: REF,
    requestedReviewers: z.array(USER),
    requestedTeams: z.array(z.unknown()),
  }),
);
const EVENT = wire(
  z
    .object({
      id: z.number().int().positive(),
      event: z.string(),
      actor: USER.nullable(),
      createdAt: z.iso.datetime(),
      assignee: USER.optional(),
      requestedReviewer: USER.nullish(),
      requestedTeam: z
        .object({ id: z.number().int().positive(), slug: z.string().min(1) })
        .nullish(),
    })
    .superRefine((event, context) => {
      const hasReviewer =
        event.requestedReviewer !== undefined &&
        event.requestedReviewer !== null;
      const hasTeam =
        event.requestedTeam !== undefined && event.requestedTeam !== null;
      if (
        (["assigned", "unassigned"].includes(event.event) &&
          event.assignee === undefined) ||
        (["review_requested", "review_request_removed"].includes(event.event) &&
          hasReviewer === hasTeam)
      ) {
        context.addIssue({
          code: "custom",
          message: "grant event lacks its target",
        });
      }
    }),
);
const REVIEW = wire(
  z
    .object({
      id: z.number().int().positive(),
      user: USER,
      state: z.string(),
      commitId: z.string().regex(SHA),
      submittedAt: z.iso.datetime().nullable(),
      pullRequestUrl: z.string(),
    })
    .transform(({ commitId: commit, pullRequestUrl: pullUrl, ...review }) => ({
      ...review,
      commit,
      pullUrl,
    })),
);
const HANDOFF = z.object({
  checkpoint: z.object({
    pr: z.number().int().positive(),
    branch: z.string().min(1),
    code: z.string().regex(SHA),
    inputs: z.string().regex(INPUT_REVISION),
    at: z.iso.datetime(),
  }),
  request: z.number().int().positive().nullable(),
  eventsBefore: z.array(z.number().int().positive()),
  review: z.number().int().positive().nullable(),
});
const COORDINATION = z.object({
  pending: z.unknown().nullable(),
  localRecovery: z.boolean(),
  handoff: HANDOFF.nullable(),
});
// Discovery never uses the display reader's catch/default values as evidence.
const STRICT_STATE = ISSUE_STATE.extend({
  asked: ISSUE_STATE.shape.asked.removeCatch(),
  resumeStage: ISSUE_STATE.shape.resumeStage.removeCatch(),
  review: ISSUE_STATE.shape.review.removeCatch().extend({
    revision: ISSUE_STATE.shape.review
      .removeCatch()
      .shape.revision.removeCatch(),
    verdict: ISSUE_STATE.shape.review.removeCatch().shape.verdict.removeCatch(),
  }),
}).superRefine((state, context) => {
  for (const inputs of [state.asked?.inputs, state.gherkin?.inputs]) {
    if (inputs !== undefined && !INPUT_REVISION.test(inputs)) {
      context.addIssue({
        code: "custom",
        message: "invalid saved input revision",
      });
    }
  }
});
const RESPONSE = z.object({
  status: z.number().int(),
  body: z.unknown(),
  link: z.string().nullable(),
});
const COMMENT_QUERY = `query($id:ID!) { node(id:$id) { ... on IssueComment {
  databaseId body createdAt updatedAt lastEditedAt author { login } editor { login }
} } }`;
const CURRENT_COMMENT = z.object({
  data: z.object({
    node: z.object({
      databaseId: z.number().int().positive(),
      body: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      lastEditedAt: z.iso.datetime().nullable(),
      author: USER,
      editor: USER.nullable(),
    }),
  }),
});

type Settings = z.infer<typeof SETTINGS>;
type Repository = z.infer<typeof REPO>;
type Worker = Settings["workers"][number];
type Issue = z.infer<typeof ISSUE>;
type Pull = z.infer<typeof PULL>;
type Event = z.infer<typeof EVENT>;
type Review = z.infer<typeof REVIEW>;
type Handoff = z.infer<typeof HANDOFF>;

export type {
  Event,
  Handoff,
  Issue,
  Pull,
  Repository,
  Review,
  Settings,
  Worker,
};
export {
  COMMENT_QUERY,
  COORDINATION,
  CURRENT_COMMENT,
  EVENT,
  HANDOFF,
  ISSUE,
  PULL,
  RESPONSE,
  REVIEW,
  SETTINGS,
  STRICT_STATE,
};
