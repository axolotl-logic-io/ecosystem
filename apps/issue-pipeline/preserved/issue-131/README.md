# Issue 131 — incomplete invocation adaptation preserved

**Not delivered, not an install candidate, and not runtime activation.** The
bounded implementation attempt stopped with the invocation/claim/state fixture
migration incomplete. All attempted runtime and test changes were removed from
active source after preserving them losslessly. The active runtime still has
#130's standalone seam and its existing caller/claim behavior. This record does
not satisfy #131's Gherkin or authorize installation, dispatch or takeover.

## Recovery artifacts

`runtime-draft.patch.gz` contains this attempt's tracked and new source/test
files, not the earlier #116 patch. Its exact Base is
`0f084d5abeaee2299b2b4c13d6cb56a6144bfecf` (the empty start-work commit after
#130). Decode into a scratch file and inspect/adapt; do not replay it wholesale.
`git apply --check` succeeded against that Base after restoration of active
source. This is an applicability check, not correctness evidence.

SHA-256:

- compressed draft: `a94745cdda89543f3e49faf5e7bde544bb9a58152df2d0a44904918d92591434`
- decoded draft: `23d5afa4f76d633e213965531028362db56aa3c182d18c22e54a476c590a8bcd`
- `checks.txt.gz`: `8e25ccaf7dfc9b5de38cee56f1d07206057066884ac46be31d3cc43863a1d955`

The compressed check log preserves successive draft measurements, including
failures. It contains local test paths; it is recovery evidence, not a PR test
certificate. Later source/fixture edits mean earlier passing measurements do
**not** validate the final draft.

## Explicit recovery and comparison

The named #116 preservation files were absent from this checkout, but their
source Git object was available. They were recovered with `git show` from
`1359f09b3b6064f6388dc14608c74968809ed677`, without moving or modifying any
branch, and retained at their originally named paths:

- [original #116 status](../issue-116.md)
- `../issue-116-runtime.patch.gz`

The recovered runtime artifact matches both issue-specified SHA-256 values:
compressed `c832099be639fa65212a5e4e1958c399377783875efa6c921091c1eb43a4bf30`;
decoded `b24ce18b28ac20e6c6e0a18f829ea8cfe9f15067efb4b683251f30d5d35a4fae`.
Its original Base remains `8141c9aa58899d0d54e4266155e95ca58c86635a`.

The mapped runtime hunks were read and adapted against current source, not
applied as a complete patch. The earlier dropped #116 ops-request, control,
control-protocol and fake-job-authority hunks were compared. In particular,
the older fixture's synthesized permission was not imported. The #73 source
artifact was recovered read-only from
`aa526f5acb3248f12293af97df815a5b81a77ac8`; its SHA-256 matches
`7b6b9196de293c093f934d7350a6720811c870bbb712c096e72601fb08ae9bd4`.
Its ops-request/claim-state binding hunks were inspected; the remaining mapped
#73 comparisons are unfinished. No assignment, discovery, loop or handoff
schema was ported. The earlier dropped patches, wiki draft, PRs, preserved
branches and unported artifacts remain unchanged.

## What the unreviewed draft attempts

- A fresh invocation UUID and exact repository/literal-base/issue/branch/lane
  binding; pre-checkout acquisition and fresh session ownership assertions.
- Bound ops/control push requests rather than sweep/job-id aliases.
- Strict UUID execution receipts checked against authenticated confirmed
  protocol history, with explicit predecessor release before sequential resume.
- Authenticated exact saved-body read-back, retained uncertain-save intent,
  preservation of existing authority fields and conservative teardown holds.
- An opt-in fake HTTP transport that stores actual adapter writes, including
  requests, confirmations, releases, epoch refs and authenticated state reads.
  Fixture predecessors use actual protocol acquisition, state save and release,
  not invented owner booleans or fabricated coordination records.

These are implementation intentions, not complete guarantees. The draft is
neither a full mutation-path audit nor a concurrency proof.

## Actual measurements during the attempt

Commands below ran inside `apps/issue-pipeline`, with the unchanged test
timeout. No test was skipped or retried to hide a flake. Diagnostic repeats
followed actual source/fixture changes and retained their failures.

1. `npm run typecheck` passed after the initial runtime adaptation, before the
   new transport fixture and later extraction/refactoring.
2. `node --test --test-timeout=180000 test/execution-runtime.test.mjs` passed
   **4/4** on an intermediate draft: fresh setup/receipt, unreleased lapsed
   predecessor refusal, unresolved state-save hold/no retry/release, and lost
   response resolved by exact read-back. This did not exercise real job launch.
3. `node --test --test-timeout=180000 test/coordination.test.mjs test/ops-claim.test.mjs`
   passed **29**, failed **6**. The unported original claim fixtures sent legacy
   envelopes; all six were refused for missing execution identity. Their
   delivery assertions were not changed to accept those refusals.
4. After attempting real-transport claim fixture migration,
   `node --test --test-timeout=180000 test/ops-claim.test.mjs` passed **4**, failed
   **2**. Live-other-owner refusal, closed-new-issue refusal, fresh setup and
   explicitly released lapsed-worktree resume passed. Answered resume lacked
   the queued PR metadata fixture; stopped resume compared a normalized log
   timestamp to an unnormalized expectation.
5. A changed-fixture answered-only diagnostic still failed, exposing that the
   extra PR replies were not actually forwarded. That forwarding and timestamp
   handling were subsequently edited, but **not validated by another test run**.
6. Final draft `npm run typecheck` failed with **TS2502** in the migrated claim
   helper annotations. Final Biome write/check still failed with **19 errors**,
   including an import cycle/barrel after extracting execution-history,
   parameter assignment, process-boundary placement, oversized fixture helpers
   and misplaced test assertions. No lint/type rule was weakened.

The final draft has not passed typecheck, lint, build, job regression tests or
the combined gate. The unchanged combined gate was not run inside the model
session. Source delivery must still run it outside targeted model checks.
Dependencies were absent, so `npm ci` was used for source checks; no environment
files were read/copied/changed and no pipeline runtime was installed.

## Checks after removing the draft

On restored active source (only README/preservation/wiki documentation changed),
`npm run typecheck`, `npm run lint` (536 files), `npm run build`, and
`node --test --test-timeout=180000 test/coordination.test.mjs test/ops-claim.test.mjs`
all passed; the test command passed **35/35**. These measure the restored
standalone-seam/legacy runtime, **not** the preserved invocation draft. They do
not turn its earlier failures into passes or establish #131 acceptance.
`restored-checks.txt.gz` retains this separate measurement, SHA-256
`b47ef92552b5b1ed382a6a9ced1f61b870ae1683c4963759df97e57e7273006f`.
The full combined gate still has not run in this session.

## Required next work

1. Resolve the final type/lint defects without disabling checks. Remove the
   execution-history re-export cycle; use its own direct imports. Reassess the
   new module boundaries rather than adding broad exceptions.
2. Complete the real claim/state/job fixture migration. Verify answered and
   stopped resume, retain complete reply/path/label assertions, and retain
   explicit refusal coverage for old same-lane and expired-lease forms.
3. Port the two job fencing tests through actual authenticated ownership reads,
   not a fake assertion reply: lost-owner refuses a real writer; stage mismatch
   preserves the checkpoint, releases safely, and the next permitted-stage
   invocation obtains a distinct UUID. The existing fake-job-authority kit is
   unported. The older #116 test's second invocation requested another mismatch,
   not the original permitted stage, so it cannot be copied as sufficient proof.
4. Add the full missing/changed execution envelope matrix, legacy/malformed/
   missing-history/provenance refusals, and receipt linkage tests. Verify the
   control push binding through the actual server boundary.
5. Retain and migrate closed-issue incomplete-Merge recovery, draft saves,
   assigned branch/head, observed/own merge, security, stop-recovery and refused
   local-work tests. Review the draft's head preservation carefully: retaining
   every old non-null head is not a proof that legitimate authorized head
   movement still works. Likewise check merged truth beyond the attempted-merge
   special case, rather than assuming the inherited save logic is sufficient.
6. Establish normal teardown/relinquishment and conservative holds with real
   checkpoint/cleanup evidence. The draft's patch-count check is not a complete
   proof about bundles, refused pushes, stop uncertainty or process interruption.
   Unknown effects must not permit release or a successor's writer.
7. Complete the remaining allocated preservation comparisons, README/wiki
   behavior documentation, targeted checks and unchanged external combined gate.
   Keep full mutation auditing/races and integration-turn composition separate.

Do not clear any durable receipts or local uncertainty/recovery evidence to get
progress. Source merging, worker installation/activation, assignments,
credentials and production release are distinct operations; this preservation
commit performs or authorizes none of the latter operations.
