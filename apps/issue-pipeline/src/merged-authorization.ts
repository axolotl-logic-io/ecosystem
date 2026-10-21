import type { IssueState, Revision } from "./state.ts";
import { sameRevision } from "./state.ts";

// Read-only recovery of historical merged/attempted work retains its original
// checked-integration provenance. Never use this to authorize a new mutation.
function recordedAuthorization(state: IssueState): Revision | null {
  const { hardened, integration } = state;
  if (hardened === null) {
    return null;
  }
  if (integration !== null && sameRevision(integration.reviewed, hardened)) {
    return integration.revision;
  }
  return hardened;
}

export { recordedAuthorization };
