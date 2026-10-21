// @ts-check
// A landed integration result keeps its genuine ordered M and original H.
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import { PR, sh } from "./ops-publish-test-kit.mjs";

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {import("../src/state.ts").Revision} */
function mergedAt(w) {
  sh(
    `git --git-dir=${w.root}/origin.git update-ref refs/heads/integration ${w.mergeSha}`,
  );
  const revision = { code: w.mergeSha, wiki: null, inputs: "inputs-1" };
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
