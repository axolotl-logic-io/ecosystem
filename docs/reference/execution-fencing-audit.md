# Execution fencing audit

This page lists every credentialed or cleanup effect the pipeline can cause and what fences it. It's the audit for #132, taken at `main` `ea483b5` (2026-10-24 19:30 EDT, UTC−04:00), after #167 and #168 landed. #151 and #170 have since fenced the release, teardown, exit-order and cleanup rows, and #169 the credentialed-write rows.

The rule each row is checked against is [`fresh-reads`](../decisions/buddies-and-tasks.md#fresh-reads): a run reads ownership immediately before each privileged effect, and a cached reading authorizes nothing.

## How a write is fenced

Every credentialed write in `apps/issue-pipeline/src` goes through two functions in `src/github.ts`. `gh()` handles each `gh` call that isn't a read, and `git()` handles each `git push`. Both hand the write to `controlledWrite`, which calls the config's `mutation` hook when the config carries an execution binding. No other module runs `gh` or a credentialed `git` itself.

What the hook does depends on the process the write runs in:

```
job process (src/job.ts)
  cfg = withExecution(binding)          src/job/invocation.ts
  mutation = controlledMutation         src/execution.ts

ops process (src/ops.ts), request with a binding
  cfg = boundOps(binding)               src/ops/execution-envelope.ts
    └─ one ownership read when the request arrives
  mutation = controlledMutation         src/execution.ts

controlledMutation, before each write
  fresh ownership read ──► lost? refuse, nothing written
  journal the exact intent ──► write ──► answered? clear the journal
                                         refused (4xx, rejected ref)? clear it
                                         anything else? keep it and hold

ops process, request with no binding
  mutation = refuse                     src/ops/execution-envelope.ts
    └─ reads still run; every credentialed write is refused
```

Both processes now read ownership on the spot before each write. A takeover between the request's check and a write is caught at the write.

The journal is `coordination-uncertain.json` in the issue's run folder. While it exists, no ownership read succeeds, so neither a replay of the request nor a new job's acquisition can repeat the write; a person reconciles it. Some writes skip that journal because their own operation already reconciles a lost reply by reading (`reconciles` in `src/github.ts`): `pushHead`'s and Sync's pushes (the push record), Land's fast-forward push (its attempt record), PR create (the PR its branch names), task-result records, and saved-state saves (every later step rereads state). They still get the fresh ownership read.

Execution fencing adds to the existing guards; it never replaces them. Code write authority (`src/write-authority.ts`), head and branch bindings, CI, approval, Security and the task-result bindings all still apply. The table names them in the "Other guards" column.

## Effects

"Ops" means the write runs in an `ops.mjs` child of a stage job. "Job" means it runs in the job process itself.

| Effect | Path | Process | Binding | Fresh ownership guard | Other guards | Status |
|---|---|---|---|---|---|---|
| Source push from `pipeline_commit` | `src/job/commit-push.ts` → `src/checkouts.ts` `pushHead` | Job | Invocation binding | Owner read at push entry (#168), then `controlledMutation` | `readWriteAuthority`, path scope | Fenced (#168) |
| Source push from the `push`, `start-pr` and `open-pr` ops | `src/ops/push.ts`, `src/ops/pr.ts` → `src/checkouts.ts` `push`, `pushHead` | Ops | Request envelope | Before each write | `readWriteAuthority`, `refuseOnceMerged` | Fenced (#169) |
| PR create and edit | `src/ops/pr.ts` `createPr`, `startPr`, `openPr` | Ops | Request envelope | Before each write | `refuseOnceMerged` | Fenced (#169) |
| PR ready | `src/ops/ready-pr.ts` | Ops | Request envelope | Before each write | Saved head, verification | Fenced (#169) |
| PR reopen | `src/ops/pr-state.ts` | Ops | Request envelope | Before each write | Closed-PR eligibility | Fenced (#169) |
| PR approval | `src/ops/pr-approval.ts` | Ops | Request envelope | Before each write | Exact head, hardening, Security | Fenced (#169) |
| State save | `src/saved-state.ts` (`save-state` op, role saves, claim transitions) | Ops | Request envelope | Before each write | Branch binding, critical-state checks | Fenced (#169) |
| Execution-state checkpoint | `src/execution-state.ts` via `src/ops/bound-claim.ts` | Ops | Request envelope | `assertExecution` and a journaled `confirmedWrite` | Saved receipt and history | Fenced (#167) |
| Queued and posted comments | `src/ops/post.ts` (`postComments` before every op, `post` op) | Ops | Request envelope | Before each write | Signed role marks | Fenced (#169) |
| Keyed comments and records | `src/comments.ts` `rawComment`, upsert (`ask`, `stop`, `usage`, merge comments, task-result records in `src/ops/task-results.ts`) | Ops | Request envelope | Before each write | Fresh record read before an append | Fenced (#169) |
| Labels | `src/labels.ts` `ensureLabels`, `setLabels`, `clearStopLabels`, stop-label clearance | Ops | Request envelope | Before each write | None | Fenced (#169) |
| Claim and heartbeat comments | `src/claims.ts` `postClaim`, `touchClaim`, `closeClaims` (`claim`, `release` ops) | Ops | Request envelope | Before each write | Earliest live claim | Fenced (#169) |
| Sync push | `src/ops/sync-task.ts` → `src/ops/sync-finish.ts` `pushBranch`; retired `src/ops/sync.ts` | Ops | Request envelope | Before each write | `sync-task-gate.ts`, write authority before reset and push | Fenced (#169) |
| Integration | `src/ops/integration-task.ts` | Ops | Request envelope | Before each write | Detached checkout; its only writes are attempt and result records | Fenced (#169) |
| Land | `src/ops/merge.ts` → `src/ops/land-task.ts` → `src/ops/branch-merge.ts` fast-forward push | Ops | Request envelope | Before each write | Exact Land binding and results, merge guard, attempt journal (`merge-attempt.ts`) | Fenced (#169) |
| Completion | `src/ops/finish.ts` `finishIssue` (close, branch delete, labels), `closeParent` | Ops | Request envelope | Before each write | Saved done and merged state | Fenced (#169) |
| Stop and stop salvage push | `src/ops/stop.ts` → `src/unpushed.ts` `pushUnpushed`, stop comments and labels | Ops | Request envelope | Before each write | `readWriteAuthority` before the push | Fenced (#169) |
| Exit salvage push | `src/job/exit-push.ts` → `exit-push` op in `src/ops/push.ts` | Ops | Request envelope | Teardown's fresh owner read first, then before each write | `readWriteAuthority`, `refuseOnceMerged`; runs only after patches and the code bundle are saved | Fenced (#169); exit order fenced (#170) |
| Teardown and checkout close | `src/job/teardown.ts`, `src/job/checkout-close.ts` | Job | Invocation binding | Fresh owner read before any patch, reset, push or removal; lost or unknown leaves the checkout untouched | Failed preservation keeps the checkout; lane setup and dependent-checkout checks | Fenced (#170) |
| Maintenance cleanup | `src/ops/cleanup.ts` → `src/ops/cleanup-fence.ts`; prune in `src/lane-slots.ts` | Ops | Request envelope, often none | A request with a binding: once per request. Each issue: authenticated coordination records, kept while any request isn't released or cancelled | Nothing unsaved; no live claim; no registered lane-slot consumer; prune deferred while any setup is pending | Fenced (#170) |
| Ownership release | `src/job/invocation.ts` `settleInvocation` → `src/job/release-predicate.ts` | Job | Invocation binding | Coordination release, confirmed by read-back | Release predicate: confirmed checkpoint, no unresolved stop or journal, preserved work, no registered consumer | Fenced (#151, #170) |
| Commit tool and control socket | `src/job/pipeline-commit-tool.ts` → `src/job/control.ts` | Job | Binding on each request | Binding must match the job's (#168) | Write scope | Fenced (#168) |
| Writer session start | `src/job/session-hooks.ts` | Job | Invocation binding | Owner read before each session (#168) | Stage and phase authority | Fenced (#168) |
| Coordination records and epoch refs | `src/execution.ts` port: comments, `git/commits`, `git/refs` | Job and ops | The binding itself | Exempt: these writes are the fence. One journaled attempt each | Read-back confirmation | Exempt (bootstrap) |
| Any write from an ops request with no binding | `src/ops.ts`, `src/ops/execution-envelope.ts` `unboundOps` | Ops | None | Refused: the hook refuses every credentialed write; reads still run | Each op's own guards | Fenced (#169) |
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

## What #169 changed

Every #169 row shares one path: the ops process's `mutation` hook. #169 made the bound hook `controlledMutation`, the one the job process already used, and gave an unbound request a hook that refuses every write. One change covers all the rows, so #169 stayed one PR.

The real ops CLI proves each row against a fake GitHub: a successor takes the issue just after the request's ownership check, and the row's first write is refused with nothing written. The refusal names the lost ownership, which only the fresh read before a write reports.

| Rows | Test |
|---|---|
| Comments, state, `ask`, keyed usage, stop, Completion (`close-parent`), lease release and claim, stop salvage push | `test/ops/ops-write-fence.test.mjs` |
| Source push (`push`, `exit-push`, `open-pr`), `start-pr`'s push and PR create | `test/ops/ops-write-fence-push.test.mjs` |
| Task records, Integration's result, Sync's push, Land's PR approval and push | `test/task-write-fence.test.mjs` |
| Bound claim's state checkpoint, and closed recovery's reopen after it | `test/ops/ops-claim.test.mjs`, `ops-claim-closed.test.mjs`, `ops-author-request.test.mjs` |
| A lost reply through a restart; an unbound request | `test/ops/ops-write-fence.test.mjs` |

PR ready and source-branch delete use the same `gh()` write path as PR create and the comment rows, with no step of their own between the hook and the write. They have no test of their own: their ops reach GitHub only after reads that the CLI fakes don't serve.
