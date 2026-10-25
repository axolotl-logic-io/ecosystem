// Version 2 of the saved state, as the release before #166 wrote it. Version
// 3 renamed four keys to the glossary's terms and changed nothing else, so a
// version 2 state reads as version 3 with its keys translated. Translation
// only renames: a part missing from the old state stays missing, and a key
// version 2 never had is dropped rather than trusted (`additive-record-
// versions`). The state comment itself is never rewritten here; the next
// save writes version 3, as every save overwrites it.

import { STATE_VERSION } from "./state.ts";

const RENAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["merged", "landed"],
  ["codeMerged", "codeLanded"],
  ["mergeAttempt", "landingAttempt"],
  ["mergeReturn", "landingReturn"],
]);
const NEW_KEYS: ReadonlySet<string> = new Set(RENAMED_KEYS.values());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The landing return's own `codeMerged` flag became `codeLanded`.
function landingReturnOf(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const { codeMerged, codeLanded: _dropped, ...rest } = value;
  if (codeMerged === undefined) {
    return rest;
  }
  return { ...rest, codeLanded: codeMerged };
}

function isVersion2(raw: unknown): raw is Record<string, unknown> {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    "version" in raw &&
    raw.version === 2
  );
}

// A version 2 state `raw` as version 3.
function fromVersion2(raw: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(raw)
    .filter(([key]) => !NEW_KEYS.has(key))
    .map(([key, value]) => {
      const renamed = RENAMED_KEYS.get(key) ?? key;
      if (renamed === "landingReturn") {
        return [renamed, landingReturnOf(value)];
      }
      return [renamed, value];
    });
  return { ...Object.fromEntries(entries), version: STATE_VERSION };
}

// `raw` as the current version: a version 2 state translated, anything
// else as it is.
function currentStateRecord(raw: unknown): unknown {
  if (isVersion2(raw)) {
    return fromVersion2(raw);
  }
  return raw;
}

export { currentStateRecord };
