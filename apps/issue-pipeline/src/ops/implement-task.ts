// Implement's read-only reconciliation (tasks/implement.ts). An Implement
// run that never settled, because its process or machine was lost or its
// end was uncertain, is settled here as failed and interrupted, by reading
// alone. Its evidence names the issue's branch and the head on GitHub now,
// which holds every commit the run's pushes published, and whether a
// continuation may follow: the run's requirements are still the issue's,
// and they have an attempt left. Nothing is pushed,
// opened or repeated: the continuation does its own push and PR, both of
// which keep existing work (checkouts.ts pushes only fast-forward, and
// open-task-pr finds the open PR first).

import type { Config } from "../config.ts";
import type { InterruptedEvidence } from "../domain.ts";
import { exactRemote } from "../tasks/view.ts";
import type { EffectOutcome } from "./task-run.ts";
import { openReconciliation, settled } from "./task-run.ts";

function implementReconcile(cfg: Config, request: unknown): EffectOutcome {
  const open = openReconciliation(
    cfg,
    request,
    "implement",
    "implement-reconcile",
  );
  const { evidence, binding, attempt } = open;
  const { branch, clone, view } = evidence;
  const head = exactRemote(cfg, clone, `refs/heads/${branch}`);
  const current =
    "requirements" in binding && binding.requirements === view.requirements;
  const continues = current;
  const interrupted: InterruptedEvidence = {
    interrupted: { branch, head, continues },
  };
  let reason = `reconciled: Implement run ${attempt.run.id} stopped before it settled`;
  if (head !== null) {
    reason = `${reason}; ${branch} is at ${head}`;
  }
  return settled(open, { verdict: "failed", reason }, interrupted);
}

export { implementReconcile };
