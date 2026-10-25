# Assignment sweep

The assignment sweep finds the work the grantor's GitHub assignments grant and starts it, so no one has to start each stage by hand. It's opt-in per repository and runs only when the operator runs it. Nothing installs or starts it.

It was built for [#73](https://github.com/axolotl-logic-io/ecosystem/issues/73) and its children #119, #120, #121, #173, #174 and #175. The audit at the end of this page traces each scenario of #73's Gherkin to a test or to the decision that retired it.

## How work flows

The grantor, `axolotl-logic`, decides who works on what by assigning GitHub issues to a buddy's account. Each sweep turns those assignments into jobs:

```
grantor assigns issue to Hippy's account
  └─ sweep: Hippy's saved stage? → implement / review job (--assignment)
       └─ job ends wait + task request (Sync) → next sweep relays it
  ... the saved stage reaches merge
grantor assigns Lawd's account too
  └─ sweep: merge job → wait + Integration request → next sweep relays it
       └─ merge job: Security, Land, Completion → issue closed
```

The sweep decides no readiness itself. Each stage job routes through the task chain (`task-readiness`) and ends `wait` with the task and exact binding it needs, which the next sweep relays unchanged, just as the [caller](caller.md) does. Claims, ownership, bindings, Security and Land all keep their own guards: an assignment grants the buddy's role's tasks for that issue and nothing else.

## Run one sweep

A repository takes part when its config names the grantor, the one account whose assignments grant and withdraw work ([`assignment-permission`](../decisions/buddies-and-tasks.md#assignment-permission)):

```json
{ "assignments": { "grantor": "axolotl-logic" } }
```

The sweep uses the caller's run folder, so `run.json`'s caps, attempts and exclusions apply to its starts exactly as to the caller's:

```sh
node "$ISSUE_PIPELINE_ROOT/sweep.mjs" --run RUN_DIR \
  --config "$ISSUE_PIPELINE_ROOT/repos/o__r.json" --lane sweep
```

It prints one JSON line per decision and exits:

```json
{"repo":"o/r","issue":7,"start":{"stage":"implement","task":null,"attempt":1,"receipt":"…"}}
{"repo":"o/r","issue":8,"hold":"refused: 1 jobs are live; the cap is 1"}
{"repo":"o/r","issue":9,"hold":"paused: axolotl-logic hasn't assigned dev-bot"}
```

## Repeat sweeps and durable holds

`--sweeps N --interval SECONDS` runs N sweeps (up to 1000) with an idle wait between them (default 60 seconds), then exits. SIGTERM or SIGINT ends it at the next sweep or during the wait. A sweep under way finishes first, and the sweep never touches a job it started: jobs run detached in their own process groups.

```sh
node "$ISSUE_PIPELINE_ROOT/sweep.mjs" --run RUN_DIR --config CONFIG \
  --lane sweep --sweeps 60 --interval 60
```

Each line then carries its sweep's number, `{"sweep": 3, "repo": …}`.

Nothing a sweep relies on lives only on this machine, so a restart, even with a new run folder, starts nothing twice:

| What stops a start | Where it's kept | What lifts it |
| --- | --- | --- |
| A live job on the issue | the run folder and job.json | the job ending |
| Another invocation owns the issue | GitHub coordination records | the owner's release, or a person's reconciliation |
| A pause | GitHub's assignment events and comments | a newer grant by the grantor |
| A stop or an unanswered question | the saved state | a person |
| A blocked end (`wait` with no task request, or `deferred`) | a hold record on the issue | a person's comment, label or assignment, a moved branch or target, or, for a deferral, its retry time |

A job started for an assignment that ends blocked writes the hold record: one keyed comment from the landing account, edited in place. It names the work that held, why, and the condition it waits on: the latest event and comment by anyone but the pipeline's accounts and the heads of the branch and the target. A deferral also sets a retry time, 1 minute after the first deferral of that work on that condition and doubling each time up to 1 hour. The sweep reads the record with landing-account authorship and editor provenance and skips the work while the condition is unchanged and the retry time hasn't passed. A hold applies only to the work it names, so progress is never held back. A body edit alone doesn't lift a hold; a comment does.

## Buddies, identities and accounts

These stay separate ([`identity-schema`](../decisions/buddies-and-tasks.md#identity-schema)). A **buddy** is Hippy or Lawd, with a role, the set of tasks it does. Its **identity** holds its accounts and model settings. An **account** is a login, such as `devAccount` on GitHub. The sweep maps work to the buddy whose role holds it, then checks that buddy's GitHub account is assigned:

| Work | Buddy | Account whose assignment counts |
| --- | --- | --- |
| Author, Implementation, Hardening (`review`), Sync | Hippy | `devAccount` |
| `merge` (Integration, Security, Land, Completion) | Lawd | `landingAccount` |

An assignment never makes either account a trusted human: trusted input is still only allowed collaborators ([`allow-listed-input`](../decisions/authority.md#allow-listed-input)). Results and receipts still come only from the landing account ([`authenticated-authority-records`](../decisions/authority.md#authenticated-authority-records)).

## Pauses and holds

A job started by the sweep carries `--assignment`. It rechecks its buddy's grant before it acquires ownership, before each writer session and push, before every credentialed write and before it applies its end. The grant holds while the grantor's latest assignment of that account stands, the issue is open (or the landing account closed it, as Completion does), and nobody else has changed an assignment or left an untrusted comment since. Anything else, including a read that failed or a listing cut short, pauses the work item. A paused job ends `wait` with `paused: …` and writes nothing more; its last saved state is its checkpoint and teardown keeps its local work in `runs/`. Only a newer grant by the grantor lifts a pause.

The table under [Repeat sweeps and durable holds](#repeat-sweeps-and-durable-holds) lists everything else that stops a start.

## Local durability limits

GitHub keeps the saved state, task results, coordination records, assignments and hold records. A replacement run rebuilds from them: the branch head equal to the saved head, the state and the task records. The clone (`clones/`) and the mirror (`work/<slug>/`) are disposable caches.

`runs/` is not a cache. It holds stop-recovery records, dropped patches, code bundles and uncertain-write journals, which never reach GitHub. Deleting it loses work that was never published; ownership held for it stays held in GitHub's coordination records until a person reconciles it. A saved head missing from the branch stops the job `branch-changed` for explicit recovery instead of starting again from the base.

A lane slot or reservation is released only when every registered consumer reports it's done ([`capacity-by-resource`](../decisions/buddies-and-tasks.md#capacity-by-resource)); a sweep never releases one.

## Coexistence with the caller

The sweep starts jobs through the caller's own launcher code, so in one run folder it shares `run.json`'s caps, attempts and exclusions and the live-job checks. Across run folders, processes or machines, issue-execution ownership admits one job per issue, and each Land takes the target's integration turn ([coordination](coordination.md)). Still, don't point a caller and a sweep at the same issues: the caller doesn't read assignments and won't pause on a withdrawal.

Jobs from different installed releases must not run at once. An older `job.mjs` doesn't know `--assignment` and refuses it, and an older release doesn't enforce the newer checks at all.

## Cut over to the sweep

Landing this source changes nothing that runs. Lawd will install what it lands once it can ([`lawd-lands-and-installs`](../decisions/buddies-and-tasks.md#lawd-lands-and-installs)); until then the operator installs. Source acceptance, Land, installation and activation are four separate steps, and each needs its own authorization.

1. Stop starting caller jobs for the repositories you'll move.
2. Wait for every running job to end (`caller-jobs.mjs wait`), and leave held issues held.
3. Keep the run folders, `runs/` and every preserved patch, bundle and stop-recovery record.
4. Reconcile any held or stopped issue as [stops and labels](stops-and-labels.md) describes.
5. Install the accepted revision, as [operations](operations.md#upgrade-safely) describes.
6. Add `"assignments": { "grantor": "axolotl-logic" }` to each moving repository's config.
7. Assign issues, then run `sweep.mjs`, once or with `--sweeps`.

To go back, stop the sweep and let its jobs end; caller jobs need no other change. Operating policy for running the pipeline unattended is [#60](https://github.com/axolotl-logic-io/ecosystem/issues/60)'s; adopting retained legacy state is [#58](https://github.com/axolotl-logic-io/ecosystem/issues/58)'s. Passing tests show these paths work in the fake world; they don't prove every cleanup is exhaustive.

## Scenario audit for #73

#73's Gherkin, revision 1, has 23 scenarios. Each is covered by a test, retired by a decision, or both. Tests are in `apps/issue-pipeline/test/`.

| # | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Configure worker identities separately from models and credentials | Retired, narrowed | `identity-schema` and `two-buddies` fix two buddies and their accounts; the only new setting is `assignments.grantor` (`assignment-sweep.test.ts`, "a repo without a grantor isn't swept") |
| 2 | Assignment alone dispatches eligible development work | Covered | `assignment-sweep.test.ts` ("one sweep starts the granted work…"), `assignment-composed.test.ts` |
| 3 | Accept only authenticated orchestration signals within their scope | Retired, replaced | `assignment-permission`: only the grantor grants. `assignment-withdrawal.test.ts` ("another account's assignment grants nothing…") |
| 4 | Untrusted or unverifiable signals do not grant work | Covered | `assignment-withdrawal.test.ts` (another account, untrusted comment, cut-short read) |
| 5 | Publish a durable developer-to-reviewer handoff | Retired | `two-buddies`: Hippy hardens, so there's no review request; the chain hands over through task results (`pipeline-flow-implementation-result.test.ts`) |
| 6 | Review ownership survives consumption of the review request | Retired | `two-buddies`, as 5; Lawd's work follows task results and saved state (`assignment-composed.test.ts`) |
| 7 | Return work for development fixes | Covered | `integration-task.test.ts` ("a failing check returns Developer work…"), `pipeline-flow-implementation-result.test.ts` (requirements edit returns to Implementation) |
| 8 | Work signals cannot bypass readiness or role checks | Covered | prerequisite: `assignment-sweep.test.ts` ("an open after prerequisite…"); another buddy's work: `assignment-composed.test.ts` (merge held until Lawd is assigned); stop, needs-info, malformed or legacy state: the claim's guards (`saved-state-classification.test.ts`, `test/job/job-stop-ask.test.ts`); approval and Security: `pipeline-flow-replay.test.ts` |
| 9 | Re-read trusted requirements before resuming a stage | Covered | `pipeline-flow-implementation-result.test.ts` ("a trusted comment that edits the requirements…") |
| 10 | Continue sweeping after idle periods and completed tasks | Covered | `assignment-repeat.test.ts`, `assignment-composed.test.ts` |
| 11 | Back off on rate limits and transport failures | Covered | `assignment-repeat.test.ts` (deferral hold, retry time doubling, restart); `test/job/job-rate-limit.test.ts` |
| 12 | Reconstruct worker and orchestrator progress from GitHub | Covered | `checkpoint-rebuild.test.ts`, `assignment-composed.test.ts` (caches deleted mid-chain), `assignment-repeat.test.ts` (new run folder) |
| 13 | Publish truthful safe checkpoints | Covered; wiki parts retired | `checkpoint-rebuild.test.ts`; no wiki path remains (docs live in `docs/`) |
| 14 | Preserve incomplete or refused local work without claiming remote recovery | Covered | `assignment-withdrawal.test.ts` (code bundle after a refused push), `test/job/pipeline-commit-merged.test.ts`, `test/job/job-release-predicate.test.ts` ("failed preservation keeps the checkout…") |
| 15 | Duplicate workers cannot execute the same issue | Covered | `pipeline-flow-contention.test.ts` (#133), `assignment-repeat.test.ts` (no second start) |
| 16 | Recover stale work without allowing a lost worker to write | Covered | `pipeline-flow-contention.test.ts` ("a predecessor delayed…"), `test/job/job-fenced-exit.test.ts` |
| 17 | Serialize integration across assignment-driven workers | Covered | `land-turn.test.ts` (#171) |
| 18 | Reconcile uncertain mutations instead of repeating them | Covered | `coordination-recovery.test.ts`, `test/job/job-release-predicate.test.ts`, `task-write-fence.test.ts`, `pipeline-flow-replay.test.ts`; wiki publication retired |
| 19 | Withdraw work safely when its grant disappears | Covered; handoff case retired | `assignment-withdrawal.test.ts` (withdrawal before and during work, closure by another account); scope removal: the sweep reads only configured repos; handoff cancellation retired by `two-buddies` |
| 20 | Inspect ownership, health and blockers through GitHub | Covered | holds and pauses are GitHub records (`assignment-repeat.test.ts`), and each sweep prints one decision line per issue; heartbeats from process IDs aren't used ([`observation-sources`](../decisions/buddies-and-tasks.md#observation-sources)) |
| 21 | Preserve the two-account and delivery boundaries | Covered | `assignment-composed.test.ts` (only Lawd records; Hippy writes only its branch and PR), `pipeline-flow-hippy-hardening.test.ts` |
| 22 | Deliberately roll out assignment-based operation | Covered | this page: opt-in per repo, cutover, coexistence |
| 23 | Verify assignment-driven operation without live services | Covered | every test above runs real binaries against the fake GitHub, fake pi and local origins, with bounded waits |

**Retired scenarios:** 5 and 6 entirely, and the handoff parts of 3 and 19, by `two-buddies`; 3's actor table by `assignment-permission`; the wiki parts of 13 and 18, since no wiki path remains; 1's configurable worker mapping, narrowed by `identity-schema` and `two-buddies` to two fixed buddies.
