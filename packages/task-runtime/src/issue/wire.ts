// GitHub REST uses snake case; domain records use camel case. Normalize only
// at the wire boundary, rejecting collisions rather than selecting one value.
import { z } from "zod";

const WORD_SEPARATOR = /_(?<letter>[a-z])/gu;

function camelName(name: string): string {
  return name.replace(WORD_SEPARATOR, (_match: string, letter: string) =>
    letter.toUpperCase(),
  );
}

function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelKeys);
  }
  const record = z.record(z.string(), z.unknown()).safeParse(value);
  if (!record.success) {
    return value;
  }
  const entries = Object.entries(record.data).map(([key, item]) => [
    camelName(key),
    camelKeys(item),
  ]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error("ambiguous GitHub wire keys");
  }
  return Object.fromEntries(entries);
}

function wire<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>, unknown> {
  return z.preprocess(camelKeys, schema);
}

export { wire };
