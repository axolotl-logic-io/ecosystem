import { z } from "zod";

const accountName = z.string().regex(/^[\w.@:/+-]{1,100}$/u);
const accountSchema = z.union([
  accountName,
  z.object({ provider: accountName, login: accountName }),
]);

/** Source metadata is an observation, never proof of identity or authority. */
function observedAccount(input: unknown): string | null {
  const parsed = accountSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  if (typeof parsed.data === "string") {
    return parsed.data;
  }
  return `${parsed.data.provider}:${parsed.data.login}`;
}

export { observedAccount };
