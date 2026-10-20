# Issue 116: incomplete development preserved

**Not a completed feature, not an install candidate, and not authority to activate workers.** The implement session stopped rather than claiming all Gherkin was delivered within the issue's 60-minute budget. No check was weakened and the existing failing acceptance assertions were left intact.

## Committed seam

Commit `8141c9aa58899d0d54e4266155e95ca58c86635a` adds:

- strict merge-authored, same-read-editor-verified append-only coordination records;
- execution UUIDs distinct from lane names; request/confirmation/save/release/cancellation scoped to an instance;
- immutable create-only repository/base epoch refs, never deleted by release, to arbitrate interleaved acquisitions;
- authenticated owner/pending-order reconstruction and predecessor refusal;
- a local uncertain-write journal and exact read-back validation, without automatic mutation retries or expiry takeover;
- explicit issue/integration protocol factories, **not called by the default runtime** in this preserved source state;
- bounded deterministic protocol tests, including competing acquisitions with incomplete initial listings.

This is a protocol seam only. It does not yet strengthen the default caller workflow. The existing runtime still has its legacy claim behavior until the wiring below is completed and reviewed. The optional internal mutation callback is not an external configuration/activation option.

## Unreviewed runtime recovery patch

- File: `issue-116-runtime.patch` in this directory.
- Exact Base: `8141c9aa58899d0d54e4266155e95ca58c86635a`.
- SHA-256: `b24ce18b28ac20e6c6e0a18f829ea8cfe9f15067efb4b683251f30d5d35a4fae`.
- Contents: README draft compatibility/cutover; `src/job.ts`, `src/job/invocation.ts`, `src/job/role-run.ts`, `src/job/teardown.ts`; `src/ops.ts`, `src/ops/claim-state.ts`, `src/ops/claim.ts`, `src/ops/save-state.ts`; `src/saved-state.ts`, `src/state.ts`, `src/write-authority.ts`; and `test/job-execution-fencing.test.mjs`.

The patch wires fresh per-invocation UUIDs into ops and commit boundaries, confirms ownership before sessions, adds strict saved execution receipts and confirmed state writes, and delays relinquishment until recovery-safe teardown. It rejects legacy work requests and pre-protocol saved authority. It is **not applied to current source**: it was saved byte-for-byte and reversed from the worktree/index before committing this preservation record. Inspect/adapt it against current source; do not automatically replay it or replace newer code with its Base.

## Actual checks performed

On the draft including runtime wiring:

- `npm run typecheck`: passed (source and checked-JavaScript tests).
- `npm run lint`: passed, 501 files; lint requirements unchanged. Only the documented Node process-boundary allowlist was extended for the filesystem/transport and invocation modules.
- `npm run build`: passed.
- `node --test --test-timeout=180000 test/coordination.test.mjs test/ops-claim.test.mjs`: **30 passed, 5 failed**. All 29 new protocol tests passed. The closed-issue refusal passed. Existing claim tests for another live claimant, fresh claim/setup, answered-issue resume, lapsed-lease resume and stopped-state resume failed. The legacy fixture's missing execution receipt now causes explicit reconciliation; the fresh-claim fixture also lacks the new GitHub commit/ref/record transport. These are real unresolved test migration failures, not flakes, and were not retried to obtain a pass.
- `node --test --test-timeout=180000 test/job-execution-fencing.test.mjs`: 2 passed. Real writer launch refused after a fresh failed ownership check; stage mismatch preserved the checkpoint, relinquished without a model, and subsequent invocation had a distinct instance on the same lane.
- `node --test --test-timeout=180000 test/coordination-interleaving.test.mjs`: 2 passed. Atomic ref contention allowed only the confirmed winner despite incomplete initial comment listings for same/different lanes.

The unchanged combined gate was not run inside the model session, per the issue's instruction. Passing targeted checks do not establish completion or a passing combined gate. The runtime patch was taken out of active source after recording these results; its failing acceptance assertions have not been edited or hidden.

After removing the runtime wiring from active source, the preserved source passed `npm run typecheck`, `npm run lint` (499 files), `npm run build`, and the two protocol files together (31 tests passed). `git apply --check` validated the recovery patch without applying it; its SHA-256 remained unchanged. This validates the preserved seam/artifact only, not the missing runtime feature.

## Remaining work before delivery

1. Migrate the existing CLI/job fake-GitHub fixtures to genuinely authenticated new requests/confirmations/releases and immutable refs. Keep branch binding, closed-merge recovery, stopped/resumed stages, saved merge/security receipts, draft-save and refused-work recovery assertions. Replace old same-lane permission reuse and expiry-takeover expectations only with explicit reconciled/released protocol cases and retain refusal tests for the old forms.
2. Complete actual runtime interleavings: duplicate jobs launching at most one real writer; lost `writeState` responses through the GitHub adapter; stale predecessor mutation at the credentialed boundary; recovery-blocked teardown/restart and sequential caller-stage resume. Core protocol counters alone do not prove every runtime boundary.
3. Exercise the real `integrationTurn` adapter explicitly across independently owned issues and caller/assignment candidates; prove reconstruction after deleting only disposable caches. Do not activate it in runtime or add scheduling/discovery/polling/handoff machinery.
4. Audit all controlled runtime mutation/maintenance paths and ensure ownership loss cannot be followed by salvage pushes or permission restored from a request snapshot. Confirm uncertain intent evidence and required local recovery survive shutdown and restart.
5. Finish/review the README and two wiki pages, removing draft status only when accurate. Run the unchanged combined gate outside the model-session targeted checks.

## Recovery and cutover constraints

Preserve authoritative GitHub comments/refs, exact uncertain-write intent, owner/order/state and required local patches, bundles, wiki refs and retained checkouts. A stale heartbeat is not takeover permission. Older runtimes do not enforce these guards; mixed old/new executors and automatic legacy adoption are not safe. A future operator-owned upgrade must stop dispatch, drain old executors, reconcile incompatible/uncertain state explicitly and coordinate replacement. Caller-dispatched merge jobs must share the same repository/base integration guard when assignment composition is later delivered; supplied order remains an additional restriction.

The issue-73 preserved branch was fetched only for inventory/comparison. Its unreviewed autonomous assignment/discovery/handoff machinery was not ported. PR104 and its source branch were not changed. No installation, activation, credential rotation or production release was performed or authorized.
