// The checks the stages' reply readers share. The readers check a session's
// structured output by hand rather than with zod: they run in the pi-subagents
// sandbox, which rejects the async functions any zod bundle contains (#178).

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

export { isRecord, isStrings };
