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
//   issue: N               work only on #N, even with an agent:stopped-* label on it
// Design and decisions: the "Issue pipeline" page of the project-buddy wiki.
//
// Everything but this loop is strict TypeScript in src/workflow/. The build
// bundles it ahead of this body as `workflowModules`, and
// src/workflow/index.ts lists every name this destructure reads. The sweep's
// driver (src/workflow/sweep.ts) owns the sweep: the sweep op, the claim, the
// stage groups on their step machines, closing parents, the release and the
// summary. This body is the one loop that awaits the launches it asks for,
// since only the body may await.

const { startSweep } = workflowModules.helpers;

if (!args.config) throw new Error("args.config must be the absolute path of a repo config file");
const sweep = startSweep(args, { sweepId: "s" + Date.now().toString(36), now: () => new Date() });
let specs = sweep.next([]);
while (specs.length > 0) specs = sweep.next(await runs.all(specs));
return sweep.summary();
