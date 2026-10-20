# Issue pipeline

By default the pipeline executes one caller-assigned GitHub issue, branch and stage per invocation. The caller owns discovery and scheduling in that mode. An explicitly enabled assignment worker can instead discover authorized GitHub assignments and handoffs, select stages and serialize integration. Both modes use the same guarded stage executor; do not run them concurrently on the same repository. The configured repository's wiki page `Reimagined-Pipeline` describes the design.

A merge changes nothing that runs. Only the operator's install does (see Install and safe upgrades).

## Stages and model roles

```text
author -> implement (draft) -> review (hardening) -> merge (integration -> branch merge -> exact-result checks -> security -> publish/close) -> done
```

| Stage / phase | Session authority | Result |
|---|---|---|
| `author` | Author, read-only | One signed Gherkin comment, edited in place when trusted input changes, or questions and `agent:needs-info` |
| `implement` | Developer (`implementor` in config), writable | Preserved issue work plus code/tests/wiki commits through `pipeline_commit`, pushed as a **draft**; no entry/resume base synchronization or mandatory verification/fix loop |
| `review` / `hardening` | Reviewer, writable | Design/correctness/test fixes and bounded configured verification/wiki-check fixes, without synchronization. Saves exact `hardened` before guarded draft readiness; an exact checkpoint resumes without another writer |
| `merge` / `integration` | Reviewer, writable only when integration needs fixes | At the caller's serialized merge turn, bounded synchronization/conflict/check/CI fixes. Saves checked integration linked to original hardening; no extra design re-review of its own checked work |
| `merge` / `security-review` | Fresh Reviewer, **read-only** | Security only (`user-harm`, `rights`, `financial-harm`, `abuse-risk`) over the **actual merged result's complete first-parent contribution**, readable merged tree and final wiki/inputs, after deterministic code merge |
| completion | Deterministic ops | Only an exact durable clear security receipt permits wiki publication and issue completion/closure |

Hardening authorizes integration, not a fictitious premerge security approval. `hardened`, `integration`, actual `merged`/`codeMerged` and `security` have separate provenance. Unexpected external heads return to hardening; trusted-input movement returns to Author. Integration's own locally checked changes do not require another design review. CI is required on the exact authorized head when configured. Deterministic issue delivery may merge into ecosystem's configured source base `main`, which has no production deployment. No model pushes a base branch, and no stage deploys production.

A security rejection leaves code **already merged**, but wiki unpublished and issue stopped. It is not a rollback. Lifting the stop cannot reroll the same rejected revision: it re-stops without a model. Remediation may need a separate issue or operator action. Missing/stale security cannot authorize completion. After interruption, an exact saved own-merge receipt and original authorization reestablish whole-change graph coverage and deterministic code/wiki checks on the exact merged result before running missing security or reusing its exact approval; they do not rerun writers, push code or merge again. Done replay with historical wiki work and missing/stale exact clearance stops for explicit reconciliation: today's unpublished diff cannot establish a receipt for yesterday's published wiki revision. Code-only replay without wiki work may still obtain fresh security after exact-result checks. Independently hardened wiki-only work after a previous code merge remains supported. A wiki-only issue merges no code and passes the same final security/publication gate.

## Explicit-target merge and result verification

The code mutation uses GitHub's documented [Merge a branch REST endpoint](https://docs.github.com/en/rest/branches/branches#merge-a-branch): `POST /repos/{owner}/{repo}/merges`, with the loaded configured repository, literal `baseBranch` and full immutable authorized head SHA H. It never lets the PR's mutable target or source branch select the write, never reloads another destination midway, and has no fallback PR merge, push, admin bypass or invented no-fast-forward option. The same PR remains the tracking anchor. Existing authorization, PR identity/base/head/draft, queue, input and wiki checks remain observations, not distributed atomicity.

Concurrent integration changes may contribute to actual result M. The guarantee is the explicit destination/source, **not** an exact prechecked result, atomic PR/input/wiki state, branch incarnation or permission/configuration snapshot. Observed invalid authority refuses writes; an unseen concurrent external merge or revocation is not atomically prevented. Caller serialization does not exclude external actors. The configured source base may be `main` (as in ecosystem); that does not grant authority to deploy or move another target's production branch.

Only HTTP 201 with a valid full SHA can begin an own-merge receipt. Before accepting it, the pipeline requires genuine same-PR MERGED metadata at exactly M with retained H, configured source/base identity, and M ancestry in freshly fetched integration. It inspects the fetched commit graph: a new accepted result differs from H and has exactly two ordered parents `[P, H]`. The API does not establish an always-no-fast-forward guarantee. Fast-forward or unsupported results, missing/unreadable/OPEN/CLOSED/mismatched metadata and missing ancestry stop, possibly **after code has landed**. They do not trigger a second merge to manufacture metadata or a rollback.

HTTP 204 is already-merged/no-op, not a new own receipt. Failed, lost, timed-out or malformed responses never automatically repeat the mutation or substitute the current base tip, H or an OPEN PR's test merge. The operation stops for read-only reconciliation through an exact saved-own receipt or the existing independently authorized external-postmerge path. Lifting a stop or rereading OPEN is not proof that an uncertain request never landed; operators must not blindly retry it. Automatic eventual progress is not promised.

Actual M, not premerge `verifiedSha=H` or head CI, must pass deterministic verification and the wiki check before read-only security/publication/completion, including own recovery and done replay. A failed own-result check retains merged truth and stops without a code writer/push. Security reads the detached M tree and the complete net contribution `P..M`; this is **not** a cumulative review of integration changes already in P. Multiple feature commits are included. Historical genuine squash receipts remain usable only when the whole original-head delta exactly equals their first-parent delta; other unsupported legacy graphs fail closed. No new receipt schema or old/new rolling-runtime compatibility is introduced. A merge changes nothing installed; cutover is operator-owned and quiescent.

`maxCiFixes`, `maxSyncs` and `maxConflictFixes` bound the corresponding fix loops. Stops have `agent:stopped-<control>` labels and a comment naming the control and recovery. Rate limits/transport errors defer rather than stop; the caller must back off before restarting. **`maxFixRounds` is obsolete, warned about and ignored**; the historical `review-rounds` stop is retained for old state/labels, not repurposed as a new limit. Caller-owned restarts must also be bounded; legacy scheduler `maxResumes` is not a new caller scheduler.

Roles live in `src/roles/`, registered in `src/roles/registry.ts`. Thin identity/tool definitions in `agents/` name `issue-pipeline-author`, `-implementor` and `-reviewer`. Per-session authority, not agent identity or prompt text, determines commit tools/scope. No model session receives a GitHub token. Network lists describe the boundary; they are not a sandbox.

## Caller invocation and concurrency

Run installed `job.mjs`, once per stage, with **one `--issue`, required `--branch` and required `--brain-path`**, including boundary prints:

```bash
node "$ISSUE_PIPELINE_ROOT/job.mjs" --config /path/to/repo.json \
  --issue 479 --branch feature/issue-479-query --brain-path /path/to/wiki-clone \
  --lane caller-query --stage author --print-boundary

node "$ISSUE_PIPELINE_ROOT/job.mjs" --config /path/to/repo.json \
  --issue 479 --branch feature/issue-479-query --brain-path /path/to/wiki-clone \
  --lane caller-query --stage author
```

The caller reads the one-line JSON result and saved issue state, then invokes the indicated next stage on the **same branch and stable `--lane`**. A lane owns the live claim across stages; omitting it gives each job a new claimant id, which cannot take a still-live earlier claim. A stage mismatch releases preserved state without running its model. Do not blindly loop on `unclaimed`, `wait`, `deferred` or `stop`. Do not use the retained autonomous orchestrator for this caller-owned workflow.

Issue/branch binding is persisted at first claim. A changed branch on resume is refused; legacy `branch:null` binds the old canonical `agent/issue-N`, not an arbitrary new branch. Protected base/wiki/remote-default branches and nonliteral/invalid refs are refused before mutation. A fresh explicit job initializes its metadata clone before posting a claim; there is no sweep prerequisite. Existing clone and issue work are reused. `--print-boundary` pins/validates prompts and prints role/checkouts/environment/network without cloning, claiming or launching pi.

Parallel jobs must use distinct issues/branches. Never dispatch the same issue/branch twice concurrently, even from the same lane. The caller serializes integration/merge turns (one at a time); existing claim/lease/head/merge-queue guards still apply. `--merge-queue N,...` carries a caller-supplied order, not permission to run concurrent turns. Keep each issue's assignment and claimant stable across restarts. Job checkouts are isolated under `work/<slug>/jobs/`; shutdown saves owned recovery patches and cleans only owned process groups. A signal exits 128 + signal, saving the last checkpoint with no lease.

## Assignment-driven workers (opt-in)

This mode replaces per-issue/per-stage dispatch, not the role programs or their
authority. The orchestrator decides assignments. Workers never assign issues,
claim unrelated labeled work, split issues, install themselves or start a service.
Omitting `assignment` keeps explicit dispatch. Delivery of these files does not
activate this mode.

Add this **non-secret** section to each operator repository configuration. The
logins must match its existing `devAccount` and `mergeAccount`; names are examples,
not hard-coded identities. `id` is the process's logical worker identity. `roles`
is its pipeline responsibility, not a model selection or credential name.

```json
{
  "assignment": {
    "enabled": true,
    "workers": [
      { "id": "development", "login": "hippy", "roles": "development" },
      { "id": "review-merge", "login": "lawd", "roles": "review" }
    ],
    "pollSeconds": 60,
    "maxBackoffSeconds": 3600,
    "heartbeatSeconds": 60,
    "pageBudget": 100
  }
}
```

IDs, accounts and responsibilities must each be unambiguous. Model choices remain
in `models`; credentials remain in private operator configuration. Repository and
worker identity changes require draining/reconciliation, not a live account swap.

An operator-owned JSON manifest is the repository allow-list. Use absolute paths
to repository configs and separately pinned brain checkouts. It may contain both
ecosystem and project-buddy, with their own base, checks, allowed humans and target
wiki settings. It never changes either repository's writable wiki target.

```json
{
  "repositories": [
    { "config": "/OPERATOR/repos/ecosystem.json", "brainPath": "/OPERATOR/brains/ecosystem" },
    { "config": "/OPERATOR/repos/project-buddy.json", "brainPath": "/OPERATOR/brains/ecosystem" }
  ]
}
```

After separate operator approval and cutover, the process interface is:

```bash
node "$ISSUE_PIPELINE_ROOT/worker.mjs" --manifest /OPERATOR/workers.json --worker development
node "$ISSUE_PIPELINE_ROOT/worker.mjs" --manifest /OPERATOR/workers.json --worker review-merge
```

These are alternative long-running worker processes, one per responsibility;
source delivery does not execute them. `--once` performs one **real** sweep, not a
dry-run. SIGINT/SIGTERM stops discovery, ends and awaits the owned stage process
group, and preserves uncertain execution ownership and local recovery evidence.

### Discovery and handoffs

The development worker paginates open issues assigned to its configured account.
It requires a currently allowed human collaborator as issue author and an
assignment event from the configured review/merge account or an allowed human
collaborator. The current assignee list alone does not establish who assigned it.
A development account may request review of its recorded PR; it cannot authorize
its own initial assignment or widen trusted human input.

The review worker paginates repository issues (including closed issues with an
unfinished recorded merge) and open PR review requests. It selects recorded
signed handoffs, not arbitrary PRs. Missing, ambiguous or unauthenticated anchors
produce a GitHub-visible hold. Exhausting the page budget is incomplete discovery,
never proof of an empty queue or unassignment.

A handoff records an ID, issue branch, exact confirmed code/private-wiki heads,
PR, input revision, assignment event and review-request event. The developer
saves it before requesting the configured reviewer. Accepted ownership remains
in signed state after GitHub consumes the request, but only with a corresponding
new review by that reviewer on the recorded head. Request cancellation or
replacement, another developer assignment, changed inputs or external heads hold
or invalidate it. Review/event snapshots prevent old same-second signals from
becoming a fresh handoff. An exact-head authenticated changes request returns the
work to development, clears old hardening/integration/security authority and keeps
feedback as operational evidence, never as trusted human issue input.

The worker preserves existing question, stop, split-parent, role, readiness,
approval, exact-result and security gates. Existing v2 work without assignment
coordination and retained legacy state require explicit reconciliation, not
automatic adoption. Trusted input changes send development back to Author before
more implementation. Unanswered needs-info work does not restart on visitor or
pipeline comments. Same-repository prerequisites use the existing
`<!-- agent-pipeline:after 12,34 -->` marker: every dependency must be closed and
completed or marked `agent:merged`. A blocked issue does not prevent another
eligible assignment from running.

### Durable coordination and recovery

GitHub is the coordination store. Signed v2 state retains stage, worker/status,
reason/retry time, confirmed checkpoints, pending mutation and accepted handoff.
Existing signed claim comments provide bounded heartbeat updates. Keyed
`assignment-observer` comments explain ignored signals and holds; they are not
human input or a substitute for signed state. The ref namespaces are reserved:

- `pipeline-execution/issue-N`: atomic create-if-absent execution fence. Each
  execution uses a unique immutable commit token and claim lane. Sharing a worker
  identity cannot admit duplicate sessions.
- `pipeline-integration/HEX_BASE`: one integration-to-completion turn per
  repository/base. Other issues can develop/harden while that turn is held.
- `pipeline-discovery/WORKER`: discovery ownership. A crash or inability to
  confirm retry-state publication leaves it held for reconciliation.
- `pipeline-retry/TIMESTAMP-ID`: durable repository retry deadline in epoch
  milliseconds. A replacement reads it before discovery can select work.

Polling defaults to 60 seconds, with configurable bounded exponential backoff
(default cap one hour). A later server Retry-After or rate-limit reset is a
minimum, not a limit to shorten. Page size is 100; the page budget defaults to
100. There is no authoritative local queue. Process records and logs help with
diagnosis, but restarting reconstructs stage selection from GitHub.

Before source/private-wiki pushes, PR creation, handoff requests, code merge,
public wiki publication or completion, the runtime saves mutation intent. It
confirms the outcome before clearing the intent. Source/wiki checkpoints require
an exact remote-head observation; a local SHA or successful command alone is not
remote recovery. Private issue-wiki pushes do not publish the public wiki base.
A lost response/save leaves a pending intent and execution fence, not permission
to repeat the mutation. Existing public-wiki and issue-completion guards still
require the actual merged result's exact clear security receipt.

Every controlled action revalidates execution ownership and the current grant.
The operator manifest, repository opt-in and worker mapping are reread; removing
scope or a grant stops newly unauthorized work. This is observation, not an atomic
transaction with external GitHub actors. Refused bytes remain in the existing
patches, bundles, wiki mirror and retained checkouts. `localRecovery` and stalled
notices explicitly distinguish them from the last confirmed remote checkpoint.
A replacement must not reset or reimplement work whose required evidence is
missing.

**Lease expiry is not takeover permission.** There is deliberately no automatic
stale-fence deletion. Before releasing stale discovery, execution or integration
ownership, the operator must stop/prove termination of the prior owner, inspect
pending intents and all local evidence, reconcile actual remote branches/PRs and
merge/publication/completion receipts, and establish current authorized scope.
Only then may ownership be released and the signed checkpoint reconciled. An old
instance must fail its token/grant/claim checks. Never remove a ref or pending
intent merely to unblock a sweep. A pending review-request response can be
reconciled against its authenticated event without reposting it; other ambiguous
outcomes may remain held for explicit recovery.

### Assignment cutover

Coordinate these operating rules with ecosystem issue **#60**. Stop new explicit
dispatch and drain/stop owned jobs before enabling assignment configs; snapshot
installed files, pins, signed state and local recovery artifacts. Review and
approve the exact code/wiki candidate, security clearance and install dry-run.
Install as one unit only while no old runtime is active. Explicit jobs without
worker execution authority are refused on opted-in repositories; do not mix
modes or installed versions. Operator approval separately controls worker launch
and any assignment changes. Retained-legacy-state adoption remains **#58**.
Nothing here installs, starts, changes credentials/assignments or deploys anything.

## Write authority and refused-work recovery

Every credentialed code push, including stop-time salvage and synchronization, checks fresh merge-authored, editor-verified saved authority and actual PR status. Missing or malformed critical state, a saved code merge, a security rejection or a confirmed live merge grants no code write. Sync checks authority before resetting or rebasing local work, as well as before its push. A diagnostic comment quoting a state marker is not a state comment; the latest genuine merge-authored, editor-verified state remains authoritative, including when it is malformed and must be recovered rather than ignored. Claims validate existing state before posting or labeling; only a genuine first claim initializes absent state, and any prior pipeline comment, local work, remote issue branch, private wiki ref or PR history without saved authority requires reconciliation. Legacy v1 state is display-only and claims refuse it with `legacy pipeline state needs explicit reconciliation`; there is no automatic adoption tool. Checkpoints and releases require already-established v2 authority. Reauthoring also validates the fresh mutation state, rather than saving tolerant display defaults as new permission.

Draft creation validates the actual PR's repository, branch, target and head, saves its identity and confirms the save before the Developer can launch a writer. An interrupted create/save with no recorded PR searches branch-scoped history across **all** PR states, bounded at 100 rows. Unreadable, malformed, ambiguous or saturated history fails closed; an empty open-only search is never evidence that no merge occurred. An explicit `open-pr` reopen request validates the old PR, reopens it, rereads OPEN authority and saves it before any guarded code push.

A historical CLOSED, unmerged PR never grants code-write authority. Genuine unchanged wiki-only work may retain its original closed PR head. Only genuine done/wiki-only replay with an exact null-code completion receipt may instead read a clean fetched-base checkout after branch deletion; the original saved head must still equal the retained PR head, and original hardening, inputs, wiki and security/publication guards remain unchanged. This does not rewrite reviewed provenance to the current base or authorize another writer/code push.

Refused commits stay local, never pushed merely to preserve them. Job teardown prepares both checkouts' separate binary-safe index and working-tree patches (each independently applies on its recorded base), and verifies a self-contained local-code bundle and strictly preserves private wiki commits in the wiki mirror before resetting or removing either checkout. A missing, unreadable or unwritable required mirror refuses preparation. Patch preparation uses a separate index; failure leaves the original files, staging and HEAD intact, and restart refuses to overwrite the checkout. Existing recovery evidence is never overwritten. A pre-push bundle can remain after a successful push; it is inert recovery, not approval or automatic replay. Final wiki-mirror reconciliation is also strict: a later failure retains the checkout and prepared evidence, but dirty files may already have been reset and must be restored from their patches. Retain these recovery artifacts and explicitly recover or relocate the checkout before restarting; nothing automatically applies or publishes them.

Synchronization cleanup also saves the staged/working patches and a verified bundle containing current, local-branch and available pre-rebase history before abort/reset/clean. Wiki rejection restores the pre-rebase head rather than an older remote issue branch. An unresolved index refuses destructive cleanup and retains the original checkout, including conflict stages, for explicit recovery. A wiki-mirror refresh updates remote-tracking refs, never private recovery heads; divergence retains both refs and refuses automatic selection.

**Concurrency limitation:** caller serialization is not external exclusion. Outside actors may push, merge, retarget or change permissions/configuration at any time. The explicit destination/immutable-source REST merge and exact-result checks above are the supported compromise, not an atomic PR/input/config transaction. Observed invalid authority refuses writes; unseen concurrent changes are not atomically prevented. No exclusion promise or credential/ruleset change is implied. Installation remains operator-owned and requires exact candidate checks and a reviewed cutover.

## Wiki prompt source and pinning

`--brain-path` is a local clone of the wiki, distinct from mutable issue docs. Behavioral instructions come **only** from these pages, selected by `(stage, phase)`:

| Stage / phase | File |
|---|---|
| author / none | `Pipeline-Prompt-Author.md` |
| implement / none | `Pipeline-Prompt-Developer.md` |
| review / hardening | `Pipeline-Prompt-Hardening.md` |
| merge / integration | `Pipeline-Prompt-Integration.md` |
| merge / security-review | `Pipeline-Prompt-Security.md` |

Before any mutation the job snapshots the pages needed by its stage. Missing/unreadable/nonplain/symlink, invalid UTF-8, NUL-containing, blank, single-line or oversized pages fail explicitly; there is **no bundled/installed/network fallback**. Each page must be multiline and at most 131071 bytes. `job.json` records path, page, SHA-256 and wiki HEAD; session launch/usage provenance records the page/hash (usage also HEAD). The exact pinned text is appended to pi's thin identity prompt with `--append-system-prompt`, so editing the clone mid-job changes no session's policy. An unmapped stage/phase cannot start. Wiki text cannot grant tools, tokens or commit permission; code checks each session's `commits` and `phase` against `STAGE_AGENTS` in `src/job/roles.ts`.

## Programs

`build.ts` bundles the entry points into `dist/`; install copies them to the pipeline root.

| Program | Purpose |
|---|---|
| `worker.mjs` | Opt-in assignment polling through `--manifest`, `--worker`, optional `--once`; no service activation |
| `job.mjs` | Explicit one-stage invocation above; `--steer <launch key> --message <text>` steers a running session |
| `ops.mjs` | Credentialed deterministic operations; framed JSON stdin (`BEGIN_OPS_REQUEST` … `END_OPS_REQUEST`, with `op` and `config`), one JSON reply |
| `report.mjs` | `usage --config <path> [--since <date>] [--role <role>] [--issue <n>]`; telemetry, not spending limits |
| `shell-supervisor.mjs` | Configured commands in owned process groups, cleaned on exit |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and scoped commit tool extensions |
| `orchestrate.mjs` | Retained legacy discovery/scheduling compatibility only; `--config <path> --brain-path <wiki clone> [--once]`. Not the caller-owned entry point; do not run it alongside caller-managed jobs |

GitHub state, claim, Gherkin, hardening and security comments require merge authorship plus same-read editor provenance to be authoritative; signatures and markers alone grant nothing. `clones/`, `work/` and `runs/` are local caches/recovery artifacts: retain them and saved patches through upgrades until preserved work is confirmed safe.

## Two GitHub identities and operator credentials

Development (`devAccount`) owns code/private-wiki
commits, source/private-wiki branch pushes and PR create/edit/reopen/close/ready/draft.
Review/merge (`mergeAccount`) owns every comment,
saved state, claim, label, authority read, explicit-target REST merge and published
wiki push. Closing a PR uses development; its accompanying comment uses merge.
Neither bot is a trusted human, even if included in `allowedUsers`. Human issue
and comment authors require both that explicit allow-list and a fresh collaborator
check; revoking either stops trust.

Configure distinct `devAccount` and `mergeAccount` and an absolute
`credentialsEnvFile` pointing to a private operator-managed file (owner-only
permissions, for example mode 0600), outside managed job worktrees, such as the
operator checkout's ignored `.env`. Required entries are
`ISSUE_PIPELINE_DEV_GITHUB_TOKEN` and `ISSUE_PIPELINE_MERGE_GITHUB_TOKEN`.
Never put token values in JSON, prompts, examples, logs or command arguments.
The loader parses that one file, takes only the selected fixed variable and never
exports dotenv values. Each selected credential is login-verified (cached only
for that account/token in the current process); missing/swapped credentials fail
closed, with no ambient, personal, keyring or role-token fallback. Public/model
config omits the file path. Legacy live `account`/`tokenFile` config is rejected
with migration instructions. Optional `legacyAccount` classifies historical
machine text for display and trusted-input exclusion only; it grants no authority.

Ordinary model/shell children lose both fixed token variables, ambient GitHub
tokens, configured legacy role-token variables and inherited Git credential/debug
injection. Privileged calls receive only their selected `GH_TOKEN`; diagnostics
redact it. Git uses a non-storing per-call helper, no personal/global helper,
HTTPS repository/wiki allow-listing and no redirects. Local test origins receive
no credentials. Submodule authentication is limited to the configured repo/wiki.
The installer never provisions operator credentials; release workflows remain unchanged. Keep the operator file out
of `apps/web/` and its app-local env files: Next/Drizzle run from that folder,
and web tooling that uses `--env-file` names its own app-local files. Never add
the operator file to a build/deploy `--env-file` invocation or export it into a
web process. Pipeline build tasks do not load it.

Every merge-authored comment is reread through GraphQL with body, author,
`lastEditedAt` and `editor` in the same response. Unedited comments require null
edit time/editor; edited comments require the merge bot as editor. Missing,
unreadable or untrusted provenance (including removed markers) stops for
reconciliation rather than falling back to an older/empty receipt. These
semantics still need the operator verification below. This is not a same-OS-user
sandbox: a child under the operator's user may still read the credential file.

## Operator setup

Configure both accounts and verify repository, PR, review and wiki capabilities.
Development opens the PR; review/merge submits a GitHub APPROVE review bound
to the exact checked commit before requesting the merge. A failed or mismatched
approval prevents the merge. Review approval is distinct from final security
clearance on the merged result.

The caller assigns issues and launches stage jobs for each configured repository,
including ecosystem itself. It monitors failures, fixes pipeline defects and
coordinates installation and useful restarts. There is no mandatory bootstrap
issue, session-refresh pause or separate scheduler prerequisite.

Keep operator credentials outside managed worktrees and verify their selected
identities without exposing token values. Before replacing an installation,
preserve active work, stop dispatch, drain its jobs and snapshot local config
and recovery state. Existing issue histories may need explicit reconciliation;
never discard retained work to make an issue look new.

## Config and model cutover

Per-repo config lives in `$ISSUE_PIPELINE_ROOT/repos/`; `repos/example.json` shows configuration, `src/config-schema.ts` its shape/defaults. `wiki` uses the repo's submodule at `wiki.dir`, published to `wiki.branch` only after final security approval. Removed config fields load with warnings; old model-role mappings are in `src/config-legacy.ts`.

The default and example role models are `openai/gpt-6.1-sol`. Set all three repository roles explicitly rather than relying on old-role aliases:

```json
{
  "models": {
    "author": "openai/gpt-6.1-sol",
    "implementor": "openai/gpt-6.1-sol",
    "reviewer": "openai/gpt-6.1-sol"
  }
}
```

All model sessions now require the explicit, separately provisioned [native runtime policy](runtime/README.md): trusted **Pi 1.2.0 + pi-cliproxyapi 0.4.3**, a dedicated model-child HOME, explicit provider extension/profile/cache, declared model credential **names** and reviewed native context-window expectations. The supported starting profile is builtin OpenAI through a distinct proxy endpoint. Set `runtime.modelContextWindows` explicitly; there is no inferred expectation. See `repos/example.json` and the nonsecret `runtime/pi-cliproxyapi-config.example.json`. Model strings pass unchanged to `--model`; unsupported registrations refuse rather than falling back.

Native automatic compaction targets **175000** tokens with **30000** recent-history tokens. For the expected 272000-token window, reserve is **97000**. This is same-session native context management, not a token/spending cap. Private generated agent settings, disabled project/personal resource discovery and correlated pre-prompt native verification enforce policy for every role. Only explicit provider/role/pipeline resources load; inherited extensions are no longer used. This is configuration isolation, **not** an OS/filesystem/keyring/network sandbox. The parent job and credentialed operations keep their own HOME and two-account boundary. Global/personal provider setup is neither copied nor changed. Tests use fake models and local origins only.

This ordinary backlog continuation is not a prerequisite for unrelated delivery. No first-issue, queue-off, session-reset or historical install/provision/STOP restriction is restored. Development uses the operator's `devAccount` (hippy for this issue); review/approval/merge uses the distinct `mergeAccount` (lawd). These names are operator choices, not hard-coded identities. Credential rotation is outside this change.

## Install and safe upgrades

The executor runs from an installed copy, not this source folder. Install only when a change affects installed source or installed assets. Documentation-only and wiki behavioral-prompt-only changes need no ceremonial binary reinstall: wiki publication and the caller's pinned-brain refresh are separate actions. Changes to installed thin agent definitions are installed assets, unlike the wiki's behavioral pages.

Operator commands for an installed-source/assets change (not an automatic release step):

```bash
npm ci                                      # monorepo root, unchanged lockfile
mise //apps/issue-pipeline:check              # exact-head combined gate
mise //apps/issue-pipeline:install:dry-run    # inspect candidate changes
mise //apps/issue-pipeline:install            # operator-authorized cutover only
```

Before upgrading: stop dispatch, drain all old-version jobs (prefer completing an active integration turn), verify no old job/session remains, snapshot installed config and signed state/recovery artifacts, pass the **exact source HEAD** full gate, review the candidate changes and install dry-run, then perform a controlled install and resume one explicitly assigned issue/stage at a time. When prompts change, review/publish the wiki and select the intended pinned brain separately; new jobs must still validate their stage's required pages. Never mix live old/new jobs or reset branches, hardening, integration, security rejections or code-merge receipts to make an upgrade pass. Unknown moved heads return conservatively to hardening; code already merged stays merged. Install/rollback of binaries does not undo code merges or publish rejected wiki work.

When pipeline operation exposes a source defect, preserve retained issue work and authoritative receipts, and deliver a tested/reviewed fix through the issue and PR workflow. Source merge does not change the installed runtime. After any necessary operator cutover and explicit recovery, restart the retained repository, issue, branch and stable lane at a stage appropriate to saved state and current inputs. Lifting a stop supplies no missing authority; ambiguous merge outcomes require read-only reconciliation, not a blind mutation retry. The wiki's [recovery procedure](https://github.com/axolotl-logic-io/ecosystem/wiki/Pipeline-Job-Contract#operator-recovery-procedure) and [cutover runbook](https://github.com/axolotl-logic-io/ecosystem/wiki/Reimagined-Pipeline#cutover) describe this process.

Record source delivery (PR/H/M), operator installation (candidate and installed identity or not applicable), wiki publication (exact revision/security evidence or pending) and pinned-brain refresh (wiki revision/page hashes or pending) separately. None implies another, and publishing the wiki changes no prompt text already pinned by a live job. Ecosystem's source-base `main` is not permission to deploy another configured repository's production branch.

Install builds first, then copies programs and example config into `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`) and thin agents into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`), filling root placeholders. It backs up replaced/retired installed files under `$ISSUE_PIPELINE_ROOT-backups/<timestamp>-install/`, records the commit in `INSTALLED.json`, refuses dirty source unless explicitly overridden and refuses installing from inside the pipeline root. The retired old `workflow.js`, escalation/ops/reader/specifier/writer agents and start/pause prompts are listed by dry-run. Per-repo operator configs, setup/teardown scripts, secrets, clones, work and runs are not rewritten by install. Wiki publication and model-config cutover remain explicit operator responsibilities. Install also copies the nonsecret runtime example, never a runnable profile/cache/credential. Merging this source does not activate it or resume jobs: the operator separately installs the accepted version and records its installed identity before resuming affected jobs.

## Tests

```bash
mise //apps/issue-pipeline:check      # source + checked-JS test types, Biome, build, syntax, every test
mise //apps/issue-pipeline:typecheck
mise //apps/issue-pipeline:lint
mise //apps/issue-pipeline:build
```

Tests use temporary HOME/pipeline roots, local bare git origins, fake GitHub and fake pi, never real GitHub/models or production data. Create/assert the temporary ROOT and set HOME/ISSUE_PIPELINE_ROOT **before dynamic source imports**: root resolution happens once on import. Full-flow regressions cover writable hardening/integration, final read-only security, wiki-only completion, explicit fresh-root invocation and claim-populated interrupted-merge replay. Legacy scheduling safety tests remain compatibility coverage, not a live dispatch recommendation. A failure or flake blocks acceptance; fix its cause rather than rerunning for a pass.
