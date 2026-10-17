// The checks the stages' reply readers share. The readers check a session's
// structured output by hand rather than with zod: they run in the pi-subagents
// sandbox, which rejects the async functions any zod bundle contains (#178).

import type { Signature } from "../signing.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

// The patch id a prepare-review reply, or a carry that kept it, names, or
// null when it names none (review-keeps-on-clean-rebase).
function patchIdIn(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const { patchId } = value;
  if (typeof patchId !== "string" || patchId === "") {
    return null;
  }
  return patchId;
}

// A signature carried between a stage's steps, or null when it is not one.
function signatureOf(value: unknown): Signature | null {
  if (!isRecord(value)) {
    return null;
  }
  const { role, agent, model, run } = value;
  if (
    typeof role !== "string" ||
    !nullableText(agent) ||
    !nullableText(model) ||
    !nullableText(run)
  ) {
    return null;
  }
  return { role, agent, model, run };
}

export { isRecord, isStrings, nullableText, patchIdIn, signatureOf };
