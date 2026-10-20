import { z } from "zod";

const USER = z.object({ login: z.string().min(1) });
const ISSUE = z.looseObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  user: USER,
  title: z.string(),
  body: z.string().nullable(),
  assignees: z.array(USER),
  labels: z.array(z.object({ name: z.string() })),
  pull_request: z.unknown().optional(),
});
const EVENT = z.looseObject({
  id: z.number().int().positive(),
  event: z.string(),
  actor: USER.nullable(),
  created_at: z.iso.datetime(),
  assignee: USER.optional(),
  requested_reviewer: USER.optional(),
});
const PR = z.looseObject({
  number: z.number().int().positive(),
  state: z.string(),
  user: USER,
  head: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
  requested_reviewers: z.array(USER),
});
const REVIEW = z.looseObject({
  id: z.number().int().positive(),
  user: USER,
  state: z.string(),
  commit_id: z.string(),
  submitted_at: z.iso.datetime().nullable(),
  body: z.string().nullable(),
});
type IssueRow = z.infer<typeof ISSUE>;
type Event = z.infer<typeof EVENT>;
type Review = z.infer<typeof REVIEW>;

type Pull = z.infer<typeof PR>;

export type { Event, IssueRow, Pull, Review };
export { EVENT, ISSUE, PR, REVIEW };
