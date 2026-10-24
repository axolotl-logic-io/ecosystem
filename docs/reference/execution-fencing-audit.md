# Execution fencing audit

This page lists every credentialed or cleanup effect the pipeline can cause and what fences it. It's the audit for #132, taken at `main` `ea483b5` (2026-10-24 19:30 EDT, UTC−04:00), after #167 and #168 landed. It records an audit result only. It doesn't claim any write is safe before #169 lands with its tests. #151 and #170 have since fenced the release, teardown, exit-order and cleanup rows.

The rule each row is checked against is [`fresh-reads`](../decisions/buddies-and-tasks.md#fresh-reads): a run reads ownership immediately before each privileged effect, and a cached reading authorizes nothing.

## How a write is fenced

Every credentialed write in `apps/issue-pipeline/src` goes through two functions in `src/github.ts`. `gh()` handles each `gh` call that isn't a read, and `git()` handles each `git push`. Both hand the write to `controlledWrite`, which calls the config's `mutation` hook when the config carries an execution binding. No other module runs `gh` or a credentialed `git` itself.

What the hook does depends on the process the write runs in:

```
job process (src/job.ts)
  cfg = withExecution(binding)          src/job/invocation.ts
  mutation = controlledMutation         src/execution.ts
    └─ fresh ownership read, journal, write, clear journal

ops process (src/ops.ts), request with a binding
  cfg = boundOps(binding)               src/ops/execution-envelope.ts
    └─ one ownership read when the request arrives
  mutation = write()                    ← no read before each write

ops process, request with no binding
  cfg.execution = undefined
  controlledWrite → write()             ← no ownership check at all
```

The job process is fenced: each write reads ownership on the spot and journals its intent in `coordination-uncertain.json`. The ops process checks once per request. A takeover between that check and a write goes unnoticed, so the ops rows below belong to #169.

Execution fencing adds to the existing guards; it never replaces them. Code write authority (`src/write-authority.ts`), head and branch bindings, CI, approval, Security and the task-result bindings all still apply. The table names them in the "Other guards" column.

## Effects

"Ops" means the write runs in an `ops.mjs` child of a stage job. "Job" means it runs in the job process itself.

| Effect | Path | Process | Binding | Fresh ownership guard today | Other guards | Owner |
|---|---|---|---|---|---|---|
| Source push from `pipeline_commit` | `src/job/commit-push.ts` → `src/checkouts.ts` `pushHead` | Job | Invocation binding | Owner read at push entry (#168), then `controlledMutation` | `readWriteAuthority`, path scope | Fenced (#168) |
| Source push from the `push`, `start-pr` and `open-pr` ops | `src/ops/push.ts`, `src/ops/pr.ts` → `src/checkouts.ts` `push`, `pushHead` | Ops | Request envelope | Once per request | `readWriteAuthority`, `refuseOnceMerged` | #169 |
| PR create and edit | `src/ops/pr.ts` `createPr`, `startPr`, `openPr` | Ops | Request envelope | Once per request | `refuseOnceMerged` | #169 |
| PR ready | `src/ops/ready-pr.ts` | Ops | Request envelope | Once per request | Saved head, verification | #169 |
| PR reopen | `src/ops/pr-state.ts` | Ops | Request envelope | Once per request | Closed-PR eligibility | #169 |
| PR approval | `src/ops/pr-approval.ts` | Ops | Request envelope | Once per request | Exact head, hardening, Security | #169 |
| State save | `src/saved-state.ts` (`save-state` op, role saves, claim transitions) | Ops | Request envelope | Once per request | Branch binding, critical-state checks | #169 |
| Execution-state checkpoint | `src/execution-state.ts` via `src/ops/bound-claim.ts` | Ops | Request envelope | `assertExecution` and a journaled `confirmedWrite` | Saved receipt and history | Fenced (#167) |
| Queued and posted comments | `src/ops/post.ts` (`postComments` before every op, `post` op) | Ops | Request envelope | Once per request, before the queued comments | Signed role marks | #169 |
| Keyed comments and records | `src/comments.ts` `rawComment`, upsert (`ask`, `stop`, `usage`, merge comments, task-result records in `src/ops/task-results.ts`) | Ops | Request envelope | Once per request | Fresh record read before an append | #169 |
| Labels | `src/labels.ts` `ensureLabels`, `setLabels`, `clearStopLabels`, stop-label clearance | Ops | Request envelope | Once per request | None | #169 |
| Claim and heartbeat comments | `src/claims.ts` `postClaim`, `touchClaim`, `closeClaims` (`claim`, `release` ops) | Ops | Request envelope | Once per request | Earliest live claim | #169 |
| Sync push | `src/ops/sync-task.ts` → `src/ops/sync-finish.ts` `pushBranch`; retired `src/ops/sync.ts` | Ops | Request envelope | Once per request | `sync-task-gate.ts`, write authority before reset and push | #169 |
| Integration | `src/ops/integration-task.ts` | Ops | Request envelope | Once per request | Detached checkout; its only writes are attempt and result records | #169 (records row) |
| Land | `src/ops/merge.ts` → `src/ops/land-task.ts` → `src/ops/branch-merge.ts` fast-forward push | Ops | Request envelope | Once per request | Exact Land binding and results, merge guard, attempt journal (`merge-attempt.ts`) | #169 |
| Completion | `src/ops/finish.ts` `finishIssue` (close, branch delete, labels), `closeParent` | Ops | Request envelope | Once per request | Saved done and merged state | #169 |
| Stop and stop salvage push | `src/ops/stop.ts` → `src/unpushed.ts` `pushUnpushed`, stop comments and labels | Ops | Request envelope | Once per request | `readWriteAuthority` before the push | #169 |
| Exit salvage push | `src/job/exit-push.ts` → `exit-push` op in `src/ops/push.ts` | Ops | Request envelope | Teardown's fresh owner read first, then once per request | `readWriteAuthority`, `refuseOnceMerged`; runs only after patches and the code bundle are saved | #169 (write); exit order fenced (#170) |
| Teardown and checkout close | `src/job/teardown.ts`, `src/job/checkout-close.ts` | Job | Invocation binding | Fresh owner read before any patch, reset, push or removal; lost or unknown leaves the checkout untouched | Failed preservation keeps the checkout; lane setup and dependent-checkout checks | Fenced (#170) |
| Maintenance cleanup | `src/ops/cleanup.ts` → `src/ops/cleanup-fence.ts`; prune in `src/lane-slots.ts` | Ops | Request envelope, often none | A request with a binding: once per request. Each issue: authenticated coordination records, kept while any request isn't released or cancelled | Nothing unsaved; no live claim; no registered lane-slot consumer; prune deferred while any setup is pending | Fenced (#170) |
| Ownership release | `src/job/invocation.ts` `settleInvocation` → `src/job/release-predicate.ts` | Job | Invocation binding | Coordination release, confirmed by read-back | Release predicate: confirmed checkpoint, no unresolved stop or journal, preserved work, no registered consumer | Fenced (#151, #170) |
| Commit tool and control socket | `src/job/pipeline-commit-tool.ts` → `src/job/control.ts` | Job | Binding on each request | Binding must match the job's (#168) | Write scope | Fenced (#168) |
| Writer session start | `src/job/session-hooks.ts` | Job | Invocation binding | Owner read before each session (#168) | Stage and phase authority | Fenced (#168) |
| Coordination records and epoch refs | `src/execution.ts` port: comments, `git/commits`, `git/refs` | Job and ops | The binding itself | Exempt: these writes are the fence. One journaled attempt each | Read-back confirmation | Exempt (bootstrap) |
| Any write from an ops request with no binding | `src/ops.ts` with no `execution` | Ops | None | None. Only the ops CLI's own tests send one; the job never does | Each op's own guards | #169 |
| Clone and fetch | `src/checkouts.ts`, `src/job/checkout.ts`, `src/git-state.ts`, `src/clone-setup.ts` | Job and ops | Either | Exempt: credentialed reads | Remote and helper checks | Exempt (read) |
| Standards assessment and admission | `src/standards/*.ts` | Standalone | None | Exempt: reads only (`allowFail` reads, `ls-remote`) | Commit binding | Exempt (read) |
| Wiki writer and publication | `src/wiki.ts`, `src/wiki-publication.ts` | — | — | — | — | Removed |

## Preserved files

The preserved patches for #116 and #73 named these files. Each line gives where the file is now. The hunk-by-hunk comparison was dropped from the drain scope.

- `src/write-authority.ts`: `src/write-authority.ts`
- `src/job.ts`: `src/job.ts`, with acquisition in `src/job/invocation.ts`
- `src/job/teardown.ts`: `src/job/teardown.ts`
- `src/ops.ts`: `src/ops.ts`, with the envelope in `src/ops/execution-envelope.ts`
- `src/ops/save-state.ts`: `src/ops/save-state.ts`
- `src/saved-state.ts`: `src/saved-state.ts`
- `src/job/commit-push.ts`: `src/job/commit-push.ts`
- `src/job/exit-push.ts`: `src/job/exit-push.ts`
- `src/job/control.ts`: `src/job/control.ts`
- `src/job/pipeline-commit-tool.ts`: `src/job/pipeline-commit-tool.ts`
- `src/ops/cleanup.ts`: `src/ops/cleanup.ts`
- `src/ops/post.ts`: `src/ops/post.ts`
- `src/execution.ts`: `src/execution.ts`
- `src/github.ts`: `src/github.ts`
- `src/checkouts.ts`: `src/checkouts.ts`
- `src/unpushed.ts`: `src/unpushed.ts`
- `src/wiki.ts`: removed
- `src/wiki-publication.ts`: removed
- `src/ops/branch-merge.ts`: `src/ops/branch-merge.ts`
- `src/ops/finish.ts`: `src/ops/finish.ts`
- `src/ops/merge.ts`: `src/ops/merge.ts`
- `src/ops/pr.ts`: `src/ops/pr.ts`
- `src/ops/sync-finish.ts`: `src/ops/sync-finish.ts`
- `src/job/checkout-close.ts`: `src/job/checkout-close.ts`

## What #169 changes

Every #169 row shares one path: the ops process's `mutation` hook. #169 replaces the pass-through hook with a fresh ownership read and a journaled attempt before each write, and refuses any write from an ops request that carries no binding. One change covers all the rows, so #169 stays one PR rather than a batch per row.
