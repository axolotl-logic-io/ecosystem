import { z } from "zod";

const BINDING = z.strictObject({
  instance: z.uuid(),
  lane: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
});
const CONSUMER = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
});
const SCOPE = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("issue"),
    issue: z.number().int().positive(),
  }),
  z.strictObject({ kind: z.literal("integration") }),
  z
    .strictObject({
      kind: z.literal("model-session"),
      slot: z.number().int().positive(),
      cap: z.number().int().positive(),
    })
    .refine((scope): boolean => scope.slot <= scope.cap),
]);
const COMMAND = z.strictObject({
  operation: z.enum([
    "read",
    "survey",
    "claim",
    "assert",
    "save",
    "release",
    "consumers",
    "register",
    "done",
  ]),
  repo: z.string().min(1),
  base: z.string().min(1),
  scope: SCOPE,
  binding: BINDING.optional(),
  buddyRunId: z.uuid().optional(),
  task: z.string().min(1).optional(),
  consumer: CONSUMER.optional(),
  evidence: z.json().optional(),
});
const CLAIM = z.object({
  id: z.number().int().positive(),
  binding: BINDING,
  cap: z.number().int().positive().optional(),
});
const CONSUMER_STATE = z.object({ consumer: CONSUMER, done: z.boolean() });
const VIEW = z.object({
  owner: CLAIM.nullable(),
  confirmed: z.boolean(),
  pending: z.array(CLAIM),
  consumers: z.array(CONSUMER_STATE),
  // Relevant history includes the caller's terminal receipt, not necessarily
  // every earlier invocation in the repository-wide pool.
  requestedInstances: z.array(z.uuid()),
  releasedInstances: z.array(z.uuid()),
});
const RESPONSE = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), result: z.json() }),
  z.strictObject({ ok: z.literal(false), reason: z.string() }),
]);

type Binding = z.infer<typeof BINDING>;
type Consumer = z.infer<typeof CONSUMER>;
type Command = z.infer<typeof COMMAND>;
type Scope = z.infer<typeof SCOPE>;
type Claim = z.infer<typeof CLAIM>;
type View = z.infer<typeof VIEW>;
type Evidence = z.infer<ReturnType<typeof z.json>>;
type Result =
  | View
  | [number, View][]
  | boolean
  | null
  | z.infer<typeof CONSUMER_STATE>[];

export type {
  Binding,
  Claim,
  Command,
  Consumer,
  Evidence,
  Result,
  Scope,
  View,
};
export { BINDING, CLAIM, COMMAND, CONSUMER, CONSUMER_STATE, RESPONSE, VIEW };
