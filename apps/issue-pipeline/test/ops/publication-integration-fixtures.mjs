// @ts-check
// A landed integration result keeps its genuine ordered M and original H.
import { setCurrentRevision } from "./fake-ops-publish-revision.mjs";
import { PR, sh } from "./ops-publish-test-kit.mjs";

/** @param {import("./ops-publish-test-kit.mjs").World} w @param {import("../../src/state.ts").Revision} authorized @returns {import("../../src/state.ts").Revision} */
function mergedAt(w, authorized) {
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
