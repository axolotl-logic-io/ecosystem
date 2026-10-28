import { z } from "zod";
import { RUNTIME_SCHEMA } from "../job/runtime-policy.ts";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_ASSIGNED_FILES = 32;
const MAX_PAGE_CHARACTERS = 20_000;
const DEFAULT_PAGE_CHARACTERS = 12_000;
const WINDOW = {
  offset: z.number().int().nonnegative().default(0),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_CHARACTERS)
    .default(DEFAULT_PAGE_CHARACTERS),
};
const PAGE: { file: z.ZodString } & typeof WINDOW = {
  file: z.string().min(1),
  ...WINDOW,
};
const HASH = z.string().regex(HASH_PATTERN);
const TARGET = z.strictObject({
  file: z.string().min(1),
  symbol: z.string().min(1),
});
const RANGE = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});

// Caller-owned scope, never accepted as a model tool argument. Revision and
// policy are attribution, not a signed workflow result or landing permission.
const ASSIGNMENT = z.strictObject({
  root: z.string().min(1),
  revision: z.string().regex(COMMIT_PATTERN),
  policy: HASH,
  behavior: z.literal("js-values-effects-v1"),
  requirements: z.string().min(1),
  prompt: z.string().min(1),
  project: z.string().min(1),
  files: z.array(z.string().min(1)).min(1).max(MAX_ASSIGNED_FILES),
  biome: z.string().min(1),
  profile: z.string().min(1),
  model: z.string().min(1),
  runtime: RUNTIME_SCHEMA,
});

type Assignment = z.infer<typeof ASSIGNMENT>;

const TYPE_TEXT = z.string().min(1).max(MAX_PAGE_CHARACTERS);
const ANNOTATION_SLOT = z.enum(["annotation", "return"]).default("annotation");
const ANNOTATION_EDITS = z
  .array(
    z.strictObject({
      symbol: z.string().min(1),
      type: TYPE_TEXT.nullable(),
      slot: ANNOTATION_SLOT,
    }),
  )
  .max(MAX_ASSIGNED_FILES)
  .default([]);
const TYPE_EDIT: {
  target: typeof TARGET;
  source: typeof HASH;
  rationale: z.ZodString;
} = {
  target: TARGET,
  source: HASH,
  rationale: z.string().min(1),
};

const OPERATION = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("inspect"), ...PAGE }),
  z.strictObject({ operation: z.literal("read"), ...PAGE }),
  z.strictObject({
    operation: z.literal("check"),
    baseline: z.boolean().default(false),
    ...WINDOW,
  }),
  z.strictObject({
    operation: z.literal("rename-symbol"),
    target: TARGET,
    source: HASH,
    name: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.strictObject({
    operation: z.literal("extract-function"),
    target: TARGET,
    range: RANGE,
    source: HASH,
    name: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.strictObject({
    operation: z.literal("introduce-type"),
    ...TYPE_EDIT,
    declaration: TYPE_TEXT,
    annotations: ANNOTATION_EDITS,
  }),
  z.strictObject({
    operation: z.literal("modify-type"),
    ...TYPE_EDIT,
    declaration: TYPE_TEXT,
    annotations: ANNOTATION_EDITS,
  }),
  z.strictObject({
    operation: z.literal("remove-type"),
    ...TYPE_EDIT,
    annotations: ANNOTATION_EDITS,
  }),
  z.strictObject({
    operation: z.literal("set-type-annotation"),
    ...TYPE_EDIT,
    type: TYPE_TEXT,
    slot: ANNOTATION_SLOT,
  }),
  z.strictObject({
    operation: z.literal("remove-type-annotation"),
    ...TYPE_EDIT,
    slot: ANNOTATION_SLOT,
  }),
]);

type Operation = z.infer<typeof OPERATION>;

const REPORT = z.strictObject({
  rationale: z.string().min(1),
  findings: z.array(
    z.strictObject({
      id: z.string().min(1),
      disposition: z.enum(["improved", "resolved", "deferred"]),
      reason: z.string().min(1),
    }),
  ),
});

type Report = z.infer<typeof REPORT>;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export type { Assignment, Operation, Report };
export {
  ASSIGNMENT,
  DEFAULT_PAGE_CHARACTERS,
  HASH,
  messageOf,
  OPERATION,
  REPORT,
};
