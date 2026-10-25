// A landed integration result keeps its genuine ordered M and original H.

import type { Revision } from "../../src/state.ts";
import { setCurrentRevision } from "./fake-ops-publish-revision.ts";
import type { World } from "./ops-publish-test-kit.ts";
import { PR, sh } from "./ops-publish-test-kit.ts";

function mergedAt(w: World, authorized: Revision): Revision {
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/integration ${w.mergeSha}`,
  );
  const revision = { ...authorized, code: w.mergeSha };
  setCurrentRevision({
    revision,
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: w.mergeSha,
      headSha: w.sha,
    },
  });
  return revision;
}

export { mergedAt };
