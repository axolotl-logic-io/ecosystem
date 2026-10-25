// The config keys #166 renamed to the glossary's terms. A config may use the
// old key or the new one, never both: the old one is read as the new one,
// with a warning naming it, and a config that sets both is refused rather
// than merged. Nothing else about a key changes.
import { OpsError } from "./ops-error.ts";

// Top-level keys, then keys inside an object key.
const RENAMED: readonly (readonly [string, string])[] = [
  ["mergeAccount", "landingAccount"],
  ["mergeConfirmation", "landingConfirmation"],
];
const RENAMED_INSIDE: readonly (readonly [string, string, string])[] = [
  ["jobRoles", "merger", "lander"],
  ["models", "implementor", "developer"],
];

interface Renamed {
  config: Record<string, unknown>;
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `from` with key `old` read as `next`, as `where` names it in a message.
function renamed(
  from: Record<string, unknown>,
  [old, next]: readonly [string, string],
  where: string,
  warnings: string[],
): Record<string, unknown> {
  if (!(old in from)) {
    return from;
  }
  if (next in from) {
    throw new OpsError(
      `config sets both ${where}${old} and ${where}${next}; keep only ${where}${next}`,
    );
  }
  warnings.push(`${where}${old} is now ${where}${next}; rename it`);
  const { [old]: value, ...rest } = from;
  return { ...rest, [next]: value };
}

// `raw`, a config file's keys, with every renamed key under its new name.
function withRenamedKeys(raw: Readonly<Record<string, unknown>>): Renamed {
  const warnings: string[] = [];
  let config: Record<string, unknown> = { ...raw };
  for (const pair of RENAMED) {
    config = renamed(config, pair, "", warnings);
  }
  for (const [parent, old, next] of RENAMED_INSIDE) {
    const inner = config[parent];
    if (isRecord(inner)) {
      config = {
        ...config,
        [parent]: renamed(inner, [old, next], `${parent}.`, warnings),
      };
    }
  }
  return { config, warnings };
}

export { withRenamedKeys };
