// Issue pipeline sweep. One run claims one issue and moves it as far as it can:
// triage -> draft PR -> spec -> implement -> PR ready -> review -> fix rounds ->
// sync with base -> checks (local verify + CI) -> acceptance -> security review
// -> merge. To work on more issues at once, run more lanes (one schedule per pi
// session, see the README); the number of lanes is not a setting.
//
// The script holds no tokens' worth of context: every model session is a fresh
// child with one narrow job, and every git/GitHub action goes through the
// deterministic ops tool (ops.mjs) via the `issue-pipeline-ops` agent.
// GitHub is the source of truth: labels plus a hidden state comment per issue.
//
// args: { config: "/abs/path/to/repos/<owner>__<repo>.json", lane: "<lane id>" }
//   lane names the worker. A lane keeps its issue across its sweeps, and lanes
//   race for new issues with claim comments (see raceForClaim in ops.mjs).
//   Without it, the run is its own lane.
//   Optional, for a run a human launches for one issue:
//   issue: N               work only on #N, and leave it alone while it has an
//                          agent:stopped-* label
//   takeStopped: true      with issue, take #N even with a stop label (a
//                          one-shot; the claim clears the label)
//   through: "<stage>"     begin no stage after this one, then release the issue
//                          at its next stage; { issue: N, through: "spec" }
//                          triages and specs #N and goes no further
// Design and decisions: the "Issue pipeline" page of the project-buddy wiki.
//
// Everything but this body is strict TypeScript in src/workflow/. The build
// bundles it ahead of this body as `workflowModules`, and
// src/workflow/index.ts lists every name this destructure reads. The sweep's
// driver (src/workflow/sweep.ts) owns the sweep: the sweep op, the claim, the
// stage groups on their step machines, closing parents, the release and the
// summary. This body only awaits the batches of launches the driver asks for,
// since only the body may await; driveBatches (src/workflow/batches.ts) chains
// them, each on the last one's results. It keeps the driver in `sweep`, and the
// build adds its last statement, `return sweep.summary();` (build.ts).

const { startSweep, driveBatches } = workflowModules.helpers;

// A sweep's id is "s" and the start time in base 36, as src/job.ts makes it.
const SWEEP_ID_RADIX = 36;

if (!args.config) {
  throw new Error(
    "args.config must be the absolute path of a repo config file",
  );
}
const sweep = startSweep(args, {
  sweepId: `s${Date.now().toString(SWEEP_ID_RADIX)}`,
  now: () => new Date(),
});
// Runs each batch the driver asks for, feeding its results back, until it asks
// for none.
await driveBatches(sweep, (specs) => runs.all(specs));
