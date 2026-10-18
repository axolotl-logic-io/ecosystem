// The role each stage job runs. A stage with no role yet is refused by the
// job with an explicit error; it never succeeds without its role.

import type { Role } from "../job/role-context.ts";
import type { Stage } from "../stages.ts";
import { authorRole } from "./author/author.ts";

const ROLES: Readonly<Partial<Record<Stage, Role>>> = {
  author: authorRole,
};

// The stage's role, or undefined when none is registered.
function roleOf(stage: Stage): Role | undefined {
  const { [stage]: role } = ROLES;
  return role;
}

export { roleOf };
