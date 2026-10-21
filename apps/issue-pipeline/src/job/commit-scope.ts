// The job-issued commit scope and its session-environment boundary. Parsing
// scope does not establish the credentialed push server's independent authority.
import { z } from "zod";

// The tool's name, as pi's --tools names it.
const COMMIT_TOOL = "pipeline_commit";
// The session variable that carries the tool's scope, as JSON.
const COMMIT_SCOPE_ENV = "ISSUE_PIPELINE_COMMIT_SCOPE";
const ACCESS = z.enum(["read", "write"]);
// One of the job's checkouts: its folder in the job's folder, and the
// stage's access to it.
const CHECKOUT_SCOPE = z.object({ dir: z.string(), access: ACCESS });
// A session's commit scope: the job's control socket, the launch it is, the
// job's start, the job's folder, its code checkout, its wiki checkout (null
// with no wiki), and the code globs, relative to the code checkout, it may
// commit. A job started before the trailer (#402) sends no `jobStartedAt`,
// and its sessions commit without the trailer.
const PATH_SCOPE = z.object({
  repo: CHECKOUT_SCOPE,
  docs: CHECKOUT_SCOPE.nullable(),
  allowed: z.array(z.string()).readonly(),
});
const COMMIT_SCOPE = PATH_SCOPE.extend({
  socket: z.string(),
  key: z.string(),
  jobStartedAt: z.string().optional(),
  root: z.string(),
});

type Access = z.infer<typeof ACCESS>;
type CheckoutScope = z.infer<typeof CHECKOUT_SCOPE>;
type CommitScope = z.infer<typeof COMMIT_SCOPE>;

// What a session may commit: its code checkout, its wiki checkout (null with
// no wiki) and the code globs it may commit (none: wiki only).
interface PathScope {
  repo: CheckoutScope;
  docs: CheckoutScope | null;
  allowed: readonly string[];
}

// The session variables that give the tool `scope`.
function commitEnvOf(scope: CommitScope): Record<string, string> {
  return Object.fromEntries([[COMMIT_SCOPE_ENV, JSON.stringify(scope)]]);
}

// The scope in a session's variables, or null when it has none or it is
// malformed.
function commitScopeIn(
  env: Readonly<Record<string, string | undefined>>,
): CommitScope | null {
  const text = new Map(Object.entries(env)).get(COMMIT_SCOPE_ENV);
  if (text === undefined) {
    return null;
  }
  try {
    const parsed = COMMIT_SCOPE.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}

export type { Access, CheckoutScope, CommitScope, PathScope };
export {
  COMMIT_SCOPE_ENV,
  COMMIT_TOOL,
  commitEnvOf,
  commitScopeIn,
  PATH_SCOPE,
};
