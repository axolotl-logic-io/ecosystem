import { z } from "zod";
import { OpsError } from "./ops-error.ts";

const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[{}:]/gu;
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
const POLICY_BINDING = z.object({
  mode: z.literal("committed"),
  settings: z.record(z.string(), z.unknown()),
  revision: z.string().regex(FULL_SHA),
  blob: z.string().regex(FULL_SHA),
  sha256: z.string().regex(SHA256),
  digest: z.string().regex(SHA256),
});

// JSON.parse silently takes the last duplicate member. Validate its syntax
// first, then compare decoded object keys so escaping cannot hide duplicates.
function parseProjectSettings(text: string): z.infer<typeof PROJECT_SETTINGS> {
  const parsed: unknown = JSON.parse(text);
  const tokens = text.match(JSON_TOKEN) ?? [];
  const objects: Set<string>[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === "{") {
      objects.push(new Set());
    } else if (token === "}") {
      objects.pop();
    } else if (tokens.at(index + 1) === ":") {
      const key = z.string().parse(JSON.parse(token));
      const object = objects.at(-1);
      if (object?.has(key)) {
        throw new OpsError(`project policy repeats field ${key}`);
      }
      object?.add(key);
    }
  }
  return PROJECT_SETTINGS.parse(parsed);
}

type ProjectPolicyBinding = z.infer<typeof POLICY_BINDING>;
type ProjectPolicySource = z.infer<typeof PROJECT_POLICY_SOURCE>;

export type { ProjectPolicyBinding, ProjectPolicySource };
export {
  POLICY_BINDING,
  PROJECT_POLICY_SOURCE,
  PROJECT_SETTINGS,
  parseProjectSettings,
};
