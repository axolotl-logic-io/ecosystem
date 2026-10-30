// Identity carried by a model session's local push requests.
import { z } from "zod";

const INVOCATION_BINDING = z.strictObject({
  instance: z.uuid(),
  lane: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
});
type InvocationBinding = z.infer<typeof INVOCATION_BINDING>;
function sameBinding(a: InvocationBinding, b: InvocationBinding): boolean {
  return (
    a.instance === b.instance &&
    a.lane === b.lane &&
    a.issue === b.issue &&
    a.branch === b.branch &&
    a.repo === b.repo &&
    a.base === b.base
  );
}

export type { InvocationBinding };
export { INVOCATION_BINDING, sameBinding };
