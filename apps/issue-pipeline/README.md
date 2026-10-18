# Issue pipeline

The pipeline executes one caller-assigned GitHub issue and branch at a time per invocation. The caller owns discovery, splitting, prerequisites, parallelism, stage selection, integration turns, stops and restarts. The executor never selects another issue. The wiki's [Reimagined pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Reimagined-Pipeline) describes the design.

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

Hardening authorizes integration, not a fictitious premerge security approval. `hardened`, `integration`, actual `merged`/`codeMerged` and `security` have separate provenance. Unexpected external heads return to hardening; trusted-input movement returns to Author. Integration's own locally checked changes do not require another design review. CI is required on the exact authorized head when configured. No stage moves or deploys `main`.

A security rejection leaves code **already merged**, but wiki unpublished and issue stopped. It is not a rollback. Lifting the stop cannot reroll the same rejected revision: it re-stops without a model. Remediation may need a separate issue or operator action. Missing/stale security cannot authorize completion. After interruption, an exact saved own-merge receipt and original authorization reestablish whole-change graph coverage and deterministic code/wiki checks on the exact merged result before running missing security or reusing its exact approval; they do not rerun writers, push code or merge again. Independently hardened wiki-only work after a previous code merge remains supported. A wiki-only issue merges no code and passes the same final security/publication gate.

## Explicit-target merge and result verification

The code mutation uses GitHub's documented [Merge a branch REST endpoint](https://docs.github.com/en/rest/branches/branches#merge-a-branch): `POST /repos/{owner}/{repo}/merges`, with the loaded configured repository, literal `baseBranch` and full immutable authorized head SHA H. It never lets the PR's mutable target or source branch select the write, never reloads another destination midway, and has no fallback PR merge, push, admin bypass or invented no-fast-forward option. The same PR remains the tracking anchor. Existing authorization, PR identity/base/head/draft, queue, input and wiki checks remain observations, not distributed atomicity.

Concurrent integration changes may contribute to actual result M. The guarantee is the explicit destination/source, **not** an exact prechecked result, atomic PR/input/wiki state, branch incarnation or permission/configuration snapshot. Observed invalid authority refuses writes; an unseen concurrent external merge or revocation is not atomically prevented. Caller serialization does not exclude external actors. Main and production remain outside pipeline authority.

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

## Write authority and refused-work recovery

Every credentialed code push, including stop-time salvage and synchronization, checks fresh account-authored saved authority and actual PR status. Missing or malformed critical state, a saved code merge, a security rejection or a confirmed live merge grants no code write. Sync checks authority before resetting or rebasing local work, as well as before its push. A diagnostic comment quoting a state marker is not a state comment; the latest genuine account-authored state remains authoritative, including when it is malformed and must be recovered rather than ignored. Claims validate existing state before posting or labeling; only a genuine first claim initializes absent state, and only an explicit, validated v1 state may migrate through claim with its actual PR reconciled. Checkpoints and releases require already-established v2 authority. Reauthoring also validates the fresh mutation state, rather than saving tolerant display defaults as new permission.

Draft creation validates the actual PR's repository, branch, target and head, saves its identity and confirms the save before the Developer can launch a writer. An interrupted create/save with no recorded PR searches branch-scoped history across **all** PR states, bounded at 100 rows. Unreadable, malformed, ambiguous or saturated history fails closed; an empty open-only search is never evidence that no merge occurred. An explicit `open-pr` reopen request validates the old PR, reopens it, rereads OPEN authority and saves it before any guarded code push.

A historical CLOSED, unmerged PR never grants code-write authority. Genuine unchanged wiki-only work may retain its original closed PR head. Only genuine done/wiki-only replay with an exact null-code completion receipt may instead read a clean fetched-base checkout after branch deletion; the original saved head must still equal the retained PR head, and original hardening, inputs, wiki and security/publication guards remain unchanged. This does not rewrite reviewed provenance to the current base or authorize another writer/code push.

Refused commits stay local, never pushed merely to preserve them. Job teardown prepares both checkouts' binary-safe dirty-work patches and verifies a self-contained local-code bundle and strictly preserves private wiki commits in the wiki mirror before resetting or removing either checkout. A missing, unreadable or unwritable required mirror refuses preparation. Patch preparation uses a separate index; failure leaves the original files, staging and HEAD intact, and restart refuses to overwrite the checkout. Existing recovery evidence is never overwritten. A pre-push bundle can remain after a successful push; it is inert recovery, not approval or automatic replay. Final wiki-mirror reconciliation is also strict: a later failure retains the checkout and prepared evidence, but dirty files may already have been reset and must be restored from their patches. Retain these recovery artifacts and explicitly recover or relocate the checkout before restarting; nothing automatically applies or publishes them.

**Unresolved concurrency blocker:** caller serialization is not external exclusion. Outside actors may push, merge, retarget or change permissions/configuration at any time. Fresh authority reads and Git pushes are not atomic together; `gh pr merge --match-head-commit` binds the head, not the mutable target. These checks close observed bypasses, not the remaining read/write races. No exclusion promise, accepted race, replacement merge protocol or credential/ruleset change is implied. Cutover remains blocked pending an approved technical resolution and fresh independent review.

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
| `job.mjs` | Explicit one-stage invocation above; `--steer <launch key> --message <text>` steers a running session |
| `ops.mjs` | Credentialed deterministic operations; framed JSON stdin (`BEGIN_OPS_REQUEST` … `END_OPS_REQUEST`, with `op` and `config`), one JSON reply |
| `report.mjs` | `usage --config <path> [--since <date>] [--role <role>] [--issue <n>]`; telemetry, not spending limits |
| `shell-supervisor.mjs` | Configured commands in owned process groups, cleaned on exit |
| `structured-output.mjs`, `pipeline-commit.mjs` | Schema-checked replies and scoped commit tool extensions |
| `orchestrate.mjs` | Retained legacy discovery/scheduling compatibility only; `--config <path> --brain-path <wiki clone> [--once]`. Not the caller-owned entry point; do not run it alongside caller-managed jobs |

Signed GitHub state, claim, Gherkin, hardening and security comments are authoritative. `clones/`, `work/` and `runs/` are local caches/recovery artifacts: retain them and saved patches through upgrades until preserved work is confirmed safe.

## Config and model cutover

Per-repo config lives in `$ISSUE_PIPELINE_ROOT/repos/`; `repos/example.json` shows configuration, `src/config-schema.ts` its shape/defaults. `wiki` uses the repo's submodule at `wiki.dir`, published to `wiki.branch` only after final security approval. Removed config fields load with warnings; old model-role mappings are in `src/config-legacy.ts`.

The default and example role models are `openai/gpt-6.1-sol`. **For the upcoming cutover explicitly set all three project roles**, rather than relying on defaults or old-role aliases:

```json
{
  "models": {
    "author": "openai/gpt-6.1-sol",
    "implementor": "openai/gpt-6.1-sol",
    "reviewer": "openai/gpt-6.1-sol"
  }
}
```

Explicit configured models remain supported and pass unchanged to pi's `--model`; this default change never rewrites an external operator config. There is no automatic Claude fallback. The operator must verify all three roles at the gated install. Use the existing inherited **pi-cliproxyapi** extension/provider setup; the pipeline does not install providers or alter global extension/configuration. Pi still loads inherited extensions, plus the pipeline's per-session extensions. Never put provider/GitHub tokens in prompts, repo files or logs. Tests exercise selection/launch with fake pi only, not real providers.

## Install and safe upgrades

The pipeline runs from an installed copy, not this source folder. Operator commands (not an automatic release step):

```bash
npm ci                                      # monorepo root, unchanged lockfile
mise //apps/issue-pipeline:check              # exact-head combined gate
mise //apps/issue-pipeline:install:dry-run    # inspect after independent review
mise //apps/issue-pipeline:install            # operator-authorized cutover only
```

Before upgrading: stop dispatch, drain all old-version jobs (prefer completing an active integration turn), verify no old job/session remains, snapshot installed config and signed state/recovery artifacts, pass the **exact source HEAD** full gate and independent security review, publish/verify the five wiki prompt pages and pin the intended wiki clone, inspect dry-run, then perform a controlled install and resume one explicitly assigned issue/stage at a time. Never mix live old/new jobs or reset branches, hardening, integration, security rejections or code-merge receipts to make an upgrade pass. Unknown moved heads return conservatively to hardening; code already merged stays merged. Install/rollback of binaries does not undo code merges or publish rejected wiki work.

Install builds first, then copies programs and example config into `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`) and thin agents into `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`), filling root placeholders. It backs up replaced/retired installed files under `$ISSUE_PIPELINE_ROOT-backups/<timestamp>-install/`, records the commit in `INSTALLED.json`, refuses dirty source unless explicitly overridden and refuses installing from inside the pipeline root. The retired old `workflow.js`, escalation/ops/reader/specifier/writer agents and start/pause prompts are listed by dry-run. Per-repo operator configs, setup/teardown scripts, secrets, clones, work and runs are not rewritten by install. Wiki publication and model-config cutover remain explicit operator responsibilities.

## Tests

```bash
mise //apps/issue-pipeline:check      # source + checked-JS test types, Biome, build, syntax, every test
mise //apps/issue-pipeline:typecheck
mise //apps/issue-pipeline:lint
mise //apps/issue-pipeline:build
```

Tests use temporary HOME/pipeline roots, local bare git origins, fake GitHub and fake pi, never real GitHub/models or production data. Create/assert the temporary ROOT and set HOME/ISSUE_PIPELINE_ROOT **before dynamic source imports**: root resolution happens once on import. Full-flow regressions cover writable hardening/integration, final read-only security, wiki-only completion, explicit fresh-root invocation and claim-populated interrupted-merge replay. Legacy scheduling safety tests remain compatibility coverage, not a live dispatch recommendation. A failure or flake blocks acceptance; fix its cause rather than rerunning for a pass.
