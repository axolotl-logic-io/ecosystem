// Shared model-session limits and structured reply validation. Tasks choose
// their sessions; no stage driver or role-based continuation runs here.
import { z } from "zod";
import type { ModelRole } from "../config-schema.ts";
import type { SessionResult } from "../domain.ts";
import type { SessionRaw } from "./raw-results.ts";
import { isTransientSessionError } from "./transient.ts";

const SESSION_MINUTES: Readonly<Record<ModelRole, number>> = {
  gherkin: 30,
  developer: 60,
  reviewer: 30,
};

function resultOf(raw: SessionRaw, schema: z.ZodType): SessionResult {
  if (!raw.ok) {
    const error = raw.error ?? "the session failed";
    return { ok: false, transient: isTransientSessionError(error), error };
  }
  const parsed = schema.safeParse(raw.structuredOutput);
  if (!parsed.success) {
    return {
      ok: false,
      transient: false,
      error: `the reply doesn't match its schema: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { ok: true, reply: parsed.data };
}

export { resultOf, SESSION_MINUTES };
