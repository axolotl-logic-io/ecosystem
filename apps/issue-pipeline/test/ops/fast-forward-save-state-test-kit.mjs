// @ts-check
// A lost native push acknowledgement followed by genuine source reconciliation.

import {
  consumed,
  post,
  prechecks,
  request,
  script,
} from "../explicit-target-test-kit.mjs";
import { ISSUE, PR, world } from "../explicit-target-world-test-kit.mjs";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import {
  confirmation,
  mergeComment,
} from "./explicit-target-recovery-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const { saveState } = await import("../../src/ops/save-state.ts");

/** @param {import("../../src/state.ts").Security["finding"]} finding */
function confirmedLostResponse(finding) {
  const w = world({ fastForward: true });
  script(w, [
    ...prechecks(w),
    post(w, { code: 1, stderr: "acknowledgement lost after receive-pack" }),
    ...confirmation(w),
    mergeComment(w),
  ]);
  const reply = merge(w.cfg, request(w), confirmationClock());
  const confirmed = readWriteState(w.cfg, ISSUE);
  const security = { revision: w.revision, commentId: PR, finding };
  saveState(w.cfg, { number: ISSUE, state: { ...confirmed, security } });
  consumed();
  return { w, confirmed, security, reply };
}

export { confirmedLostResponse };
