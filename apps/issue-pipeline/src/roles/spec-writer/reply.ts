// The spec writer role's reply: its schema (SPEC_WRITER_SCHEMA, the spec
// stage's SPEC_SCHEMA plus `no-work`, the test interfaces, the reason for
// writing no tests, whether the wiki is the whole change, and the optional `handoff` status and its summary), and
// what the role reads from a reply: the decision `check-reply` routes on, a
// handoff, a failed session, or a split it refuses. The
// reader parses with zod: unlike the spec stage's reader (#178), it never
// runs in workflow.js's sandbox. Pure.

import { z } from "zod";
import type { JsonSchema } from "../../workflow/schemas.ts";
import { SPEC_SCHEMA, STR } from "../../workflow/schemas.ts";
import type { SpecPart } from "../../workflow/stages/build-replies.ts";
import { SPEC_END } from "../../workflow/stages/build-replies.ts";

type SpecInterfaceKind =
  | "function"
  | "module"
  | "cli"
  | "ops-request"
  | "http"
  | "ui"
  | "config";

type SpecInterfaceStatus = "existing" | "new" | "changed";

// A public interface the spec's tests drive (the wiki's
// Pipeline-Roles-Spec-Writer, "Test interfaces").
interface SpecInterface {
  // Its name, or several names that share `where`, separated by commas or
  // "and" ("TABLE, LIMITS and transition").
  name: string;
  kind: SpecInterfaceKind;
  // `file:line` for an existing interface, or the new file's path.
  where: string;
  status: SpecInterfaceStatus;
  // Its call shape: parameters and return, flags, request and reply, or
  // route and roles.
  signature: string;
  // The Behaviour items tests check through it, quoted from the spec.
  behaviours: string[];
}

type SpecWriterDecision = "ready" | "needs-info" | "split" | "no-work";

interface SpecWriterReply {
  decision: SpecWriterDecision;
  // The spec, with its end marker removed.
  spec: string;
  questions: string[];
  subIssues: SpecPart[];
  interfaces: SpecInterface[];
  // Why the spec writer wrote no tests, or null when it wrote them.
  noTestsReason: string | null;
  // Whether the wiki pages it changed are the whole change; false when the
  // reply doesn't say.
  wikiOnly: boolean;
}

// What the role reads from a reply: a decision with the reply, a handoff
// with its summary (#335), a failed session with its reason, or a split it
// won't open with the stop's reason.
type SpecReading =
  | { kind: SpecWriterDecision; reply: SpecWriterReply }
  | { kind: "handoff"; summary: string }
  | { kind: "bad"; reason: string }
  | { kind: "refused"; reason: string };

const INTERFACE_KINDS: readonly SpecInterfaceKind[] = [
  "function",
  "module",
  "cli",
  "ops-request",
  "http",
  "ui",
  "config",
];
const INTERFACE_STATUSES: readonly SpecInterfaceStatus[] = [
  "existing",
  "new",
  "changed",
];
const DECISIONS: readonly SpecWriterDecision[] = [
  "ready",
  "needs-info",
  "split",
  "no-work",
];
// A finished session's status, or a handoff when it ran out of room (#335).
const SPEC_STATUSES: readonly ("done" | "handoff")[] = ["done", "handoff"];
// The most questions or parts a reply may give.
const MOST_ITEMS = 5;
const SPLIT_TOO_SMALL = "the spec writer's split had fewer than 2 parts";
const SUB_ISSUE_SPLIT = "a sub-issue can't split again";
const NO_MARKER = `the spec doesn't end with ${SPEC_END}, so the session stopped partway`;
const NO_INTERFACES =
  "a ready reply gave no interfaces and no noTestsReason, so no test is tied to its Behaviour";

const STRINGS: JsonSchema = { type: "array", items: STR };

const INTERFACE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: STR,
    kind: { enum: INTERFACE_KINDS },
    where: STR,
    status: { enum: INTERFACE_STATUSES },
    signature: STR,
    behaviours: STRINGS,
  },
  required: ["name", "kind", "where", "status", "signature", "behaviours"],
};

const SPEC_WRITER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...SPEC_SCHEMA.properties,
    decision: { enum: DECISIONS },
    interfaces: { type: "array", items: INTERFACE_SCHEMA },
    noTestsReason: { type: ["string", "null"] },
    wikiOnly: { type: "boolean" },
    status: { enum: SPEC_STATUSES },
    summary: STR,
  },
  required: [
    ...(SPEC_SCHEMA.required ?? []),
    "interfaces",
    "noTestsReason",
    "wikiOnly",
    "status",
    "summary",
  ],
};

const PART: z.ZodType<SpecPart> = z.strictObject({
  title: z.string(),
  body: z.string(),
  after: z.array(z.number()),
});

const INTERFACE: z.ZodType<SpecInterface> = z.strictObject({
  name: z.string(),
  kind: z.enum(INTERFACE_KINDS),
  where: z.string(),
  status: z.enum(INTERFACE_STATUSES),
  signature: z.string(),
  behaviours: z.array(z.string()),
});

const INTERFACES = z.array(INTERFACE);

const REPLY: z.ZodType<SpecWriterReply> = z.strictObject({
  decision: z.enum(DECISIONS),
  spec: z.string(),
  questions: z.array(z.string()).max(MOST_ITEMS),
  subIssues: z.array(PART).max(MOST_ITEMS),
  interfaces: INTERFACES,
  noTestsReason: z.string().nullable(),
  wikiOnly: z.boolean().default(false),
  status: z.enum(SPEC_STATUSES).optional(),
  summary: z.string().optional(),
});

// A handoff, whatever the reply's other fields: the session's own, or the
// one the job builds for a session it stopped at the hard context limit.
const HANDOFF = z.looseObject({
  status: z.literal("handoff"),
  summary: z.string(),
});

// A ready reply, unless no interface and no reason to write no tests ties a
// test to its Behaviour.
function readyReading(reply: SpecWriterReply): SpecReading {
  if (reply.interfaces.length === 0 && reply.noTestsReason === null) {
    return { kind: "bad", reason: NO_INTERFACES };
  }
  return { kind: "ready", reply };
}

function splitReading(reply: SpecWriterReply, depth: number): SpecReading {
  if (depth >= 1) {
    return { kind: "refused", reason: SUB_ISSUE_SPLIT };
  }
  if (reply.subIssues.length < 2) {
    return { kind: "refused", reason: SPLIT_TOO_SMALL };
  }
  return { kind: "split", reply };
}

function decidedReading(reply: SpecWriterReply, depth: number): SpecReading {
  switch (reply.decision) {
    case "ready":
      return readyReading(reply);
    case "needs-info":
      if (reply.questions.length === 0) {
        return readyReading(reply);
      }
      return { kind: "needs-info", reply };
    case "split":
      return splitReading(reply, depth);
    case "no-work":
      return { kind: "no-work", reply };
    default: {
      const unhandled: never = reply.decision;
      return unhandled;
    }
  }
}

// What the role reads from the session's `output` on an issue at `depth` (0
// for an issue, 1 for a sub-issue). A reply whose status is `handoff` is a
// handoff. A reply that doesn't fit the schema, or whose spec doesn't end
// with SPEC_END, is a failed session; otherwise the marker is stripped from
// the spec.
function specReadingOf(output: unknown, depth: number): SpecReading {
  const handoff = HANDOFF.safeParse(output);
  if (handoff.success) {
    return { kind: "handoff", summary: handoff.data.summary };
  }
  const parsed = REPLY.safeParse(output);
  if (!parsed.success) {
    const reason = `the reply doesn't fit the spec writer's schema: ${z.prettifyError(parsed.error)}`;
    return { kind: "bad", reason };
  }
  const text = parsed.data.spec.trimEnd();
  if (!text.endsWith(SPEC_END)) {
    return { kind: "bad", reason: NO_MARKER };
  }
  const spec = text.slice(0, -SPEC_END.length).trimEnd();
  return decidedReading({ ...parsed.data, spec }, depth);
}

// Saved interfaces, or undefined when `value` isn't a list of them.
function interfacesOf(value: unknown): SpecInterface[] | undefined {
  const parsed = INTERFACES.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export type {
  SpecInterface,
  SpecInterfaceKind,
  SpecInterfaceStatus,
  SpecReading,
  SpecWriterDecision,
  SpecWriterReply,
};
export { interfacesOf, SPEC_WRITER_SCHEMA, specReadingOf };
