import { z } from "zod";

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;
const PATH_SEPARATOR = /[\\/]/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TEXT = z
  .string()
  .refine(
    (value: string): boolean =>
      value.trim() !== "" && !value.includes("\u0000"),
    "must be nonblank text without NUL",
  );
const COMMAND = TEXT.nullish();
const RELATIVE_PATH = TEXT.refine(
  (value: string): boolean =>
    !(ABSOLUTE_PATH.test(value) || value.split(PATH_SEPARATOR).includes("..")),
  "must be a path inside the checkout",
);
const PROJECT_SETTINGS = z.strictObject({
  commands: z.strictObject({
    setup: COMMAND,
    test: TEXT,
    lint: COMMAND,
    typecheck: COMMAND,
    teardown: COMMAND,
    prune: COMMAND,
  }),
  practices: z.array(RELATIVE_PATH).optional(),
  lockfiles: z
    .array(z.strictObject({ path: RELATIVE_PATH, regenerate: TEXT }))
    .optional(),
  migrations: z
    .strictObject({
      pathGlobs: z.array(TEXT).min(1),
      setup: COMMAND,
      up: TEXT,
      down: COMMAND,
    })
    .nullish(),
});
const PROJECT_POLICY_SOURCE = z.strictObject({
  repository: TEXT.refine(
    (value: string): boolean => ABSOLUTE_PATH.test(value),
    "must be an absolute path",
  ),
  revision: z.string().regex(FULL_SHA, "must be a full immutable commit SHA"),
});
const POLICY_BINDING = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("legacy"),
    digest: z.string().regex(SHA256),
    settings: z.record(z.string(), z.unknown()),
  }),
  z.object({
    mode: z.literal("committed"),
    settings: z.record(z.string(), z.unknown()),
    revision: z.string().regex(FULL_SHA),
    blob: z.string().regex(FULL_SHA),
    sha256: z.string().regex(SHA256),
    digest: z.string().regex(SHA256),
  }),
]);

type ProjectPolicyBinding = z.infer<typeof POLICY_BINDING>;
type ProjectPolicySource = z.infer<typeof PROJECT_POLICY_SOURCE>;

export type { ProjectPolicyBinding, ProjectPolicySource };
export { POLICY_BINDING, PROJECT_POLICY_SOURCE, PROJECT_SETTINGS };
