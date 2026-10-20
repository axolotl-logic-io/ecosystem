# Issue pipeline

The pipeline executes one caller-assigned GitHub issue and branch at a time per invocation. The caller owns discovery, splitting, prerequisites, parallelism, stage selection, integration turns, stops and restarts. The executor never selects another issue. The configured repository's wiki page `Reimagined-Pipeline` describes the design.

A merge changes nothing that runs. Only the operator's install does (see Install and safe upgrades).

## Standalone coordination seam — runtime fencing unfinished

`src/coordination-records.ts`, `src/coordination.ts` and `src/execution.ts`
provide an **explicit-only protocol seam**, not activated runtime fencing.
Default `job`, `ops`, `orchestrate` and `report` entry points do not reach the
`issueExecution` or `integrationTurn` factories. Existing caller dispatch,
claim/lease behavior, saved authority, head/CI/wiki/security checks and account
roles are unchanged. Assignment mode remains disabled. Continue to avoid
duplicate issue/branch dispatch and serialize integration turns yourself.

The seam creates a fresh UUID independently of a stable lane, binding it to
repository, literal base, issue and assigned branch. Issue-execution scopes
bind the issue and branch; integration-turn order is shared across issues for
the configured repository/base. Requests, owner confirmations, saves, releases
and cancellations are append-only, merge-authored and same-read-editor-verified.
Create-only epoch refs arbitrate acquisitions; the protocol never replaces or
deletes them. Neither a request nor a successful ref creation grants save or
release authority: exact authenticated owner confirmation is required. Every
save/release freshly checks that exact execution and epoch. Release advances
the epoch without deleting history, and cancellation removes only its own
pending request. A fresh reader reconstructs pending order from durable records,
not a private queue, heartbeat, local lease or cache.

A lost/failed response may still have landed. Before a coordinated write the
transport exclusively retains exact intent in the issue run directory's
`coordination-uncertain.json`; only exact authenticated read-back clears it.
Unresolved outcomes hold for explicit reconciliation without repeating the
mutation. Preserve that file and durable comments/refs; local recovery evidence
is not authority. Malformed, conflicting, unreadable or provenance-invalid
required evidence holds rather than falling back to cached/older/empty state.
The optional internal transport callback remains a composition hook, not a
configuration switch or a claim that all runtime mutations are fenced.

This slice adapts protocol commit `8141c9a` and its 31 bounded tests, with
additional validation, interleaving, adapter and non-activation regressions.
The `1359f09` preservation record was inspected. Issue #73's earlier create-only
ref idea was compared, but its delete-on-release implementation was not imported.
The older #116 dropped snapshot/register protocol and fixtures were compared
for lost-write and reconstruction cases, not imported as duplicate authority.
PR #124, `agent/issue-116`, preservation branches and unported recovery artifacts
remain unchanged; `issue-116-runtime.patch.gz` is **not applied**.

Runtime integration-turn composition remains #120; handoff, withdrawal/checkpoints
and full composition/operations remain #118, #119 and #121. No scheduler,
polling, handoff, automatic legacy adoption, alternate delivery path, worker
installation/activation or production deployment is introduced. Merging source
does not install anything; a future cutover remains operator-owned and requires
separate runtime work and review.

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

Before the POST, a merge-authored, editor-verified `mergeAttempt` checkpoint is saved and reread. It binds the configured repository, PR, literal target, source branch, original authorization, hardening and integration. This is **attempt evidence, not an own receipt**: even an interruption before sending the request closes automatic code-write and repeat-POST authority. A successful HTTP 201 with a valid full result SHA M is saved and reread separately, before reading delayed PR metadata. Losing that response evidence cannot be repaired by inferring it from today's PR or target tip.

Only that durable HTTP 201 result can begin an own-merge receipt. Bounded read-only reconciliation requires genuine same-PR MERGED metadata at exactly M with retained H, the exact repository/PR URL and number, configured source/base identity, and M ancestry in freshly fetched integration. It inspects fetched commit objects: a new accepted result differs from H and has exactly two ordered parents `[P, H]`, with unambiguous source history. A later target tip does not replace M. The API does not establish an always-no-fast-forward guarantee. Fast-forward or unsupported graphs, malformed/mismatched identity, OPEN/CLOSED metadata, missing results and absent ancestry cannot establish an own receipt, possibly **after code has landed**. Independently observed valid merged truth is retained even when own provenance cannot be confirmed. No second merge manufactures evidence; no rollback is attempted.

Reconciliation uses an **elapsed-time deadline per invocation with spaced, bounded backoff**, not an immediate-pass or lifetime-read limit. The safe defaults allow **90 seconds** for delayed PR metadata, including lag exceeding 60 seconds. Configure both values together in repository config:

```json
{
  "mergeConfirmation": {
    "deadlineSeconds": 90,
    "backoffSeconds": [1, 2, 4, 8, 10]
  }
}
```

`deadlineSeconds` is an integer from 1 through 600. `backoffSeconds` is a nonempty list of at most 20 integer waits, each from 1 through 60 seconds. The first evidence pass is immediate; subsequent failed passes wait according to the schedule, repeating its final wait and clipping the last wait to the remaining window. Defaults are used when the entire setting is omitted; shortening the window intentionally reduces tolerated lag. A monotonic clock bounds one run, and no new evidence pass starts at or after its deadline. In-flight commands retain their existing transport bounds and may finish beyond it; late own evidence must be confirmed in a later run. Exact matching evidence ends waiting immediately. There is no background timer or unattended restart loop.

The cumulative read count is durably checkpointed before each pass as audit evidence, **not** a lifetime limit. Every pass retains the same PR identity, genuine MERGED state, retained H/returned M, fetched graph/target ancestry and current trusted-input/wiki requirements; waiting relaxes none of them. Only evidence checkpoints/comments are written, never code, another approval, a fallback merge or a writer session. Matching evidence saves the own receipt before exact-result processing. Deadline expiry reports that code may already have landed and another POST or code writer is not authorized. It preserves the exact attempt, response and original authorization, leaving wiki publication, security clearance and completion blocked.

HTTP 204 is already-merged/no-op, not a new own receipt. Failed, lost, timed-out or malformed responses never automatically repeat the mutation or substitute the current base tip, H or an OPEN PR's test merge. Reconciliation/restart may retain genuine merged truth, but without the exact saved successful response it cannot claim that this operation produced the merge. Continuation then needs the existing independently authorized external-postmerge path (hardening against the observed merged result), just as a PR merged by another actor before this operation does.

**Bounded operator recovery:** stop dispatch for this issue; retain the authoritative state comment, local recovery artifacts, original hardening/integration, attempt identity, saved response M (if any), merged facts and security receipts. Diagnose the metadata/transport problem read-only. With the same issue/branch/lane, configured target, original authorization, trusted inputs and wiki revision, lift the stop and explicitly authorize **one bounded restart at `merge`**. That run reads the saved attempt and successful response without repeating approval or the merge POST. An earlier expired window (or historical read count) does not permanently disqualify exact evidence that arrives later: the caller-authorized run gets its own finite confirmation window without resetting any saved evidence. If identity/authorization changed or exact evidence is still unavailable at that deadline, stop for explicit reconciliation; do not keep restarting automatically. A confirmed own receipt resumes exact-M checks and missing read-only security through the ordinary merge stage; a durable rejection of that revision re-stops without rerolling security. Never resend an uncertain merge manually, repeat approval, reopen a code writer, reset the attempt/read evidence, clear merged truth or erase a security rejection to obtain progress. OPEN is not proof the request never landed. Automatic eventual progress is not promised.

Actual M, not premerge `verifiedSha=H` or head CI, must pass deterministic verification and the wiki check before read-only security/publication/completion, including own recovery and done replay. A failed own-result check retains merged truth and stops without a code writer/push. Security reads the detached M tree and the complete net contribution `P..M`; this is **not** a cumulative review of integration changes already in P. Multiple feature commits are included. Historical genuine squash receipts remain usable only when the whole original-head delta exactly equals their first-parent delta; other unsupported legacy graphs fail closed. Existing own/completion receipt semantics are retained; v2 state adds optional durable attempted-merge evidence, strictly validated when present. Older states without it remain readable, but missing historical response evidence is never invented. This is not old/new rolling-runtime compatibility: an older binary does not enforce the new attempt barrier. A merge changes nothing installed; cutover is operator-owned and quiescent.

`maxCiFixes`, `maxSyncs` and `maxConflictFixes` bound the corresponding fix loops. Stops have `agent:stopped-<control>` labels and a comment naming the control and recovery. Rate limits/transport errors defer rather than stop; the caller must back off before restarting. **`maxFixRounds` is obsolete, warned about and ignored**; the historical `review-rounds` stop is retained for old state/labels, not repurposed as a new limit. Caller-owned restarts must also be bounded; legacy scheduler `maxResumes` is not a new caller scheduler.

Roles live in `src/roles/`, registered in `src/roles/registry.ts`. Thin identity/tool definitions in `agents/` name `issue-pipeline-author`, `-implementor` and `-reviewer`. Per-session authority, not agent identity or prompt text, determines commit tools/scope. No model session receives a GitHub token. Network lists describe the boundary; they are not a sandbox.

## Read-only Git subagent

`agents/git-reviewer.md` is a dedicated supervisor-usable agent, not a replacement for the shared writable `issue-pipeline-reviewer`. Install includes its explicit `subagentOnlyExtensions` path to `git-review.mjs`; naming a tool without loading that extension is insufficient. The agent has exactly `read`, `grep`, `find`, `ls`, `git_review`, no shell/write/commit tool. Supervisors must launch it with resource discovery disabled and without unrelated extensions/MCP servers that would add command execution authority. Existing hardening, integration, security authority and prepared bundles are unchanged.

The trusted supervisor provisions `PI_GIT_REVIEW_ROOTS` **in the child session environment** as a nonempty JSON array of absolute local repository roots. It must narrow this per task, not accept a repository's or reviewer's assertion of authority. Missing/malformed authority fails closed. Task text is not environment configuration. Use `cwd` equal to a canonical allowed repository root (subdirectory cwd is not supported):

```json
{"cwd":"/local/review/repo","argv":["diff","BASE..HEAD"],"offset":1,"limit":200}
```

Pass immutable commit IDs for assigned reviews. The reviewer can request later pages directly and independently inspect history, for example:

```json
{"cwd":"/local/review/repo","argv":["log","--oneline","--max-count=20","HEAD"]}
{"cwd":"/local/review/repo","argv":["blame","--line-porcelain","HEAD","--","src/file.ts"]}
{"cwd":"/local/review/repo","argv":["grep","-n","-e","pattern","HEAD","--","src"]}
```

The tool accepts only `diff`, `show`, `log`, `rev-parse`, `merge-base`, `ls-tree`, `cat-file`, `status`, `blame`, `grep`, with an explicit conservative option grammar in `src/job/git-review-policy.ts`. Paths follow `--`, grep patterns follow `-e`; pathspec magic, traversal, metadata paths, escaping symlinks, global options and unknown modes are refused. Supported common modes include patch/stat/name-only diff, cached diff, oneline/builtin log formats, numeric attached `--max-count=N`/`-nN`/`-UN`, revision verification, recursive trees, `cat-file -p/-t/-s`, porcelain status, and porcelain/numeric `-LN,M` blame. Arbitrary pretty formats, signature verification, `--no-index`, contents/pattern files, batch/filter modes, external programs and alternate Git directories are not supported.

Git is spawned directly as `/usr/bin/git`, never via a shell, with a constant minimal environment, an empty temporary HOME, no host/global/system Git configuration, no credentials/askpass/agent or inherited execution overrides, no terminal input, and file-only transports. A private metadata view omits **all** repository configuration and hooks; applicable diff commands force `--no-ext-diff --no-textconv`. Only a plain `.git` directory is supported; linked worktrees/gitfiles, reftable, metadata symlinks and object alternates are refused. SHA-1 and SHA-256 object stores are supported. Query execution does not write the original files/index/refs/config; optional locks are disabled. Temporary views are removed after Git exits. The private view's object store is local; no fetch or lazy credential discovery is authorized. Worktree queries preflight the private index and check implicit tracked paths too, including dangling/escaping symlinks. `diff` and `status` fail explicitly when an indexed submodule is initialized: Git could otherwise start a child in that submodule and load its untrusted configuration. Use `show`/`log` for committed evidence (including gitlink changes), or inspect a standalone submodule clone with its own explicit root authority; no submodule evidence is silently omitted.

Output is cached per canonical repository and exact requested argv for this session. Limits: 32 MiB complete query output, 30-second execution timeout, UTF-8 output, 8192-byte requests, at most 1000 lines and **48 KiB for the serialized entire result**, including metadata/END. Oversized page limits are capped. If a line cannot fit intact, that offset returns an explicit error with no served-range record. Narrow oversized queries; do not claim missing evidence was read.

Each successful tool-result `details` records `sessionId`, `queryId`, `repository`, `argv`, `totalLines`, `exitCode`, `startLine`, `endLine`. `exitCode` preserves successful predicate outcomes, including 0/1 for `merge-base --is-ancestor`; both outcomes can have empty output. Ranges are one-based/inclusive and represent **actual** delivery, not the requested limit. Empty output has `totalLines: 0`, null bounds and END, not a fictitious line. Only the page reaching the last line carries `=== END ===`. Failures have error details, not coverage. On session start the cache/identity resets; resuming another session does not inherit evidence records.

For chunked reviews, assign the root and exact query, not generated diff files. Inspect the reviewer's persisted tool-result details/session records. Group by session/query/repository/argv, confirm consistent totalLines, sort and union successful inclusive ranges; require every line `1..totalLines`. Repeats/overlaps count once; another query/repo/session cannot fill a gap. An END marker or reviewer claim alone proves nothing about earlier pages. Delivery is not comprehension, review quality, merge authorization or security clearance.

This is the **Git execution boundary**, not an OS/filesystem/keyring/network sandbox. The retained read tools can read same-user files and are not confined by this root allowlist. Do not promise universal credential-file isolation. Optional macOS sandboxing, writer shell isolation, credential rotation and production deployment are outside this feature. Merging does not install or activate it.

## Opt-in assignment discovery module (read-only)

`src/discovery/plan.ts` exports `discoverAssignments(configuration, reader)` and the `DiscoveryPlan`, `Candidate`, `Hold`, `DiscoveryReader` and `ReadRequest` types. This is a **source-module seam**, not an installed worker program. Nothing imports it from the job executor or retained orchestrator. Existing explicit issue/branch/stage dispatch is unchanged; omitting this API call does no discovery. Configuration must explicitly contain `enabled: true`; disabled, missing or structurally invalid configuration rejects before making any reads.

The discovery configuration is independent of repository model-role configuration and private credential selection. For example (logins below are illustrative operator choices):

```json
{
  "enabled": true,
  "allowRepositories": [
    "axolotl-logic-io/ecosystem",
    "axolotl-logic-io/project-buddy"
  ],
  "repositories": [
    {
      "repo": "axolotl-logic-io/ecosystem",
      "devAccount": "development-login",
      "mergeAccount": "review-login",
      "allowedUsers": ["trusted-human"],
      "baseBranch": "main"
    },
    {
      "repo": "axolotl-logic-io/project-buddy",
      "devAccount": "development-login",
      "mergeAccount": "review-login",
      "allowedUsers": ["trusted-human"],
      "baseBranch": "main"
    }
  ],
  "workers": [
    {
      "repository": "axolotl-logic-io/ecosystem",
      "login": "development-login",
      "worker": "ecosystem-development",
      "roles": ["development"],
      "reviewer": "review-login"
    },
    {
      "repository": "axolotl-logic-io/ecosystem",
      "login": "review-login",
      "worker": "ecosystem-review",
      "roles": ["review"]
    },
    {
      "repository": "axolotl-logic-io/project-buddy",
      "login": "development-login",
      "worker": "buddy-development",
      "roles": ["development"],
      "reviewer": "review-login"
    },
    {
      "repository": "axolotl-logic-io/project-buddy",
      "login": "review-login",
      "worker": "buddy-review",
      "roles": ["review"]
    }
  ],
  "requestBudget": 100
}
```

Only explicitly allowed, configured repositories are read. Each repository requires a nonempty `allowedUsers` list; neither configured bot becomes a trusted human through that list. Repository/login comparisons are case-insensitive. Duplicate repository definitions, duplicate login mappings (even if identical), or conflicting logical-worker mappings fail closed, never first-match/default-worker resolution. Each mapping is repository-scoped; its permitted roles are `development` and/or `review`. `reviewer` is the configured reviewer's GitHub login, not a model name. Repository settings also accept `legacyAccount`, `skipLabels` (default `[]`) and `takeNewWork` (default `true`); `baseBranch` defaults to `main`. No model, provider, credential path or token belongs in this configuration.

### Reader and authentication contract

An explicitly opting-in caller supplies a **trusted authenticated GitHub transport**, not model-produced records or preapproved eligibility booleans:

```ts
import { discoverAssignments } from "./src/discovery/plan.ts";

const plan = await discoverAssignments(configuration, {
  read: async (request) => transport.readOneGitHubResponse(request),
});
```

`transport` above is an application-owned dependency, not an adapter delivered here. `ReadRequest` permits only a REST `GET` (`repository`, repository-scoped `path`) or the module's fixed read-only GraphQL issue-comment query (`repository`, `query`, `id`). Return `{ status, body, link }`: the HTTP status, decoded **complete** JSON response body and raw REST Link header (`null` when absent; also `null` for GraphQL). REST bodies use GitHub's documented wire names; the boundary normalizes snake-case keys and rejects colliding spellings before schema validation. The reader must deliver genuine GitHub responses for the requested repository, preserve HTTP errors, and throw for failed/partial transport or JSON decoding. It must not fabricate fields, cache away revocation, follow pages, retry internally, silently truncate a body, or perform writes. One call must mean **one request attempt**. The module deliberately does not call the existing automatically retrying `ghJson` helper, select credentials, or accept arbitrary GraphQL queries from work text. This contract is an in-process trust boundary, not protection against a malicious caller/transport.

The module lists assigned open issues and all open PRs (filtering requested reviewers), follows REST pagination to completion, and reads issue comments, assignment/review-request events, collaborator membership, linked issue/state/dependencies and PR reviews as needed. PR bodies starting with the existing `Closes #N` convention locate an issue only; they confer no authority. Review candidates must independently match that issue's trusted saved PR number, development author, repository/base, branch and head revision. An external/fork PR or a copied issue link cannot substitute for the recorded PR.

Current assignee/reviewer lists are discovery signals, **not grants**. The latest matching GitHub grant/removal event supplies actor provenance. A human actor and the issue author must be in `allowedUsers` and still be collaborators; neither configured bot is a human even if allow-listed. The configured merge identity can orchestrate grants. Development can request only its configured reviewer, with no additional user/team targets, on its own recorded PR and a matching saved handoff. Missing events, unreadable collaborator checks and contradictory evidence fail closed; copied comment markers establish neither an event actor nor saved authority. Valid historical team events do not grant work to a login or invalidate an independent user request.

Saved state uses the existing strict claim/write-authority validation, never the tolerant display/migration reader. All merge-authored comments are reread with body, author, edit time and editor in the **same GraphQL response**, including comments whose markers were removed. Only merge-authored, editor-verified v2 state is planning evidence. Discovery additionally validates question/review fields without display defaults. Legacy, forged, malformed, uncertain attempted-merge/postmerge or local-recovery records remain held; discovery never adopts or rewrites them. Missing state alongside prior merge-account or recognized legacy machine comments also requires reconciliation. Merged labels and saved completion/security receipts cannot restart development.

The read-only handoff input is the saved state's optional `coordination.handoff`, with `coordination.pending: null` and `localRecovery: false`. Its required binding is:

```ts
{
  checkpoint: { pr: number, branch: string, code: string, inputs: string, at: string },
  request: number | null,
  eventsBefore: number[],
  review: number | null
}
```

`code` is the full PR head SHA; `inputs` is the trusted-input revision; `at` is an ISO timestamp. A review-request grant must match that checkpoint, occur at/after it, be absent from `eventsBefore`, and match the recorded request event ID when non-null. A saved request also listed in `eventsBefore` is contradictory, not a valid handoff. Missing handoffs stay held even for an otherwise authenticated orchestrator. A recorded merge-account review is accepted only when its genuine GitHub review ID, PR URL, commit and submission time match the saved handoff, current recorded PR and trusted-input revision. A saved review missing from GitHub is incomplete; another PR's or an older revision's review cannot satisfy it. Unbound merge reviews hold the affected PR conservatively rather than approving or reinterpreting them. This module writes no handoff lifecycle.

Trusted human requirements use exactly the existing title/body/comment hashing format. Visitors, both configured bots and recognized legacy machine comments cannot change that revision or answer needs-info. Stops, unanswered questions, split/skip labels, disabled new work and existing `after` prerequisites remain controls. Existing `parent` markers are read as relationships, not newly invented prerequisites. Unreadable dependencies are not permission. Changed trusted input sends development planning back to `author`; it holds review for return to Author rather than skipping authoring.

### Plans, bounds and continuation

`DiscoveryPlan` contains `executionAuthority: false`, `requests`, `complete`, `candidates`, `holds` and `continuations`. A candidate identifies repository, issue/PR number, linked issue, GitHub login, logical worker, permitted role, suggested existing stage, trusted-input revision and grant/review evidence IDs. Development suggests only `author`/`implement`; review suggests only `review`/`merge`. **Every returned plan grants no execution authority**, including a candidate suggesting merge. It cannot authorize a session, claim, state save, comment, label/assignment/review-request change, submitted review or merge. Any future executor would need its own fresh authorization; this snapshot is not a lease or a claim.

`requestBudget` defaults to **100**, must be an integer from **1 through 1000**, and covers the entire sweep across repositories, including every listing page, event/comment/review page, same-read editor query, collaboration check, state/input and dependency read. There are no hidden retries. Calls stop at the budget; unrelated unfinished work gets explicit holds too. Pagination validates endpoints, filters and next-page progression. Contradictory pagination relations remain incomplete. A full page without conclusive Link metadata requires another bounded read rather than implying completion. Failed, malformed or partial reads never become an empty array; comment pages must include author and body fields rather than silently defaulting missing requirements. A transport that silently discards response bytes violates the reader contract; no client can authenticate omitted bytes from such a transport.

`complete: true` means all required reads for the evaluated snapshot finished, **not** that every item was eligible. A completed empty listing can therefore have no candidates/continuations; a refused mapping can have a complete snapshot with a hold. `complete: false` means some listing or required evidence is incomplete. Fully authenticated independent candidates may still be shown, but missing results never prove unassignment or an authoritative empty queue. This is an observational sweep, not an atomic GitHub snapshot: concurrent changes can occur between reads.

Each hold has repository, work kind/number/login, typed `reason`, stable `evidence`, `incomplete` and `deduplicationKey`. Reasons distinguish repository/mapping/role, scope/provenance/state, stop/needs-info/dependency/inputs, and budget/read/page failures. The key is a deterministic JSON tuple of normalized work identity, reason and evidence, suitable for deduplicating repeated unchanged rejections without posting anything to GitHub. `continuations` are the incomplete holds: retry descriptors identifying the unfinished listing/page or evidence, **not resumable authority**. Retry with an explicit new sweep after fixing the read/configuration/budget; no automatic polling, persisted cursor, rejection-notification service or unassignment inference is supplied.

Source delivery adds no live worker entry point, provider setup, installation, activation or production deployment. No wiki changes are needed for this module seam.

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

Canonical claim normally requires an open issue. A closed issue may recover only genuine merge-authored, editor-verified incomplete Merge state (including a stop resuming Merge) with a recorded PR freshly confirmed merged into the configured base and no contradictory saved merge provenance. Eligibility and branch binding are checked before claim/state/working-label writes; only the winning claimant reopens it, using the merge identity and confirming it open. Done/non-Merge, missing/untrusted/malformed state and unconfirmed merges stay refused. This covers GitHub default-branch auto-close before verification/Security/completion, not a general closed-issue retry or lease override. Exact saved own-merge receipts retain original authorization. A confirmation race first reconciles its saved attempt and successful HTTP response, if present; without that response it still needs the independently authorized postmerge path. Neither recovery path pushes code or repeats the merge POST. Actual-result verification, wiki checks and exact read-only Security still gate wiki publication and completed closure; a saved exact rejection is not rerolled.

Issue/branch binding is persisted at first claim. A changed branch on resume is refused; legacy `branch:null` binds the old canonical `agent/issue-N`, not an arbitrary new branch. Protected base/wiki/remote-default branches and nonliteral/invalid refs are refused before mutation. A fresh explicit job initializes its metadata clone before posting a claim; there is no sweep prerequisite. Existing clone and issue work are reused. `--print-boundary` pins/validates prompts and prints role/checkouts/environment/network without cloning, claiming or launching pi.

Parallel jobs must use distinct issues/branches. Never dispatch the same issue/branch twice concurrently, even from the same lane. The caller serializes integration/merge turns (one at a time); existing claim/lease/head/merge-queue guards still apply. `--merge-queue N,...` carries a caller-supplied order, not permission to run concurrent turns. Keep each issue's assignment and claimant stable across restarts. Job checkouts are isolated under `work/<slug>/jobs/`; shutdown saves owned recovery patches and cleans only owned process groups. A signal exits 128 + signal, saving the last checkpoint with no lease.

## Write authority and refused-work recovery

Every credentialed code push, including stop-time salvage and synchronization, checks fresh merge-authored, editor-verified saved authority and actual PR status. Missing or malformed critical state, a saved code merge, a security rejection or a confirmed live merge grants no code write. Sync checks authority before resetting or rebasing local work, as well as before its push. A diagnostic comment quoting a state marker is not a state comment; the latest genuine merge-authored, editor-verified state remains authoritative, including when it is malformed and must be recovered rather than ignored. Claims validate existing state before posting or labeling; only a genuine first claim initializes absent state, and any prior pipeline comment, local work, remote issue branch, private wiki ref or PR history without saved authority requires reconciliation. Legacy v1 state is display-only and claims refuse it with `legacy pipeline state needs explicit reconciliation`; there is no automatic adoption tool. Checkpoints and releases require already-established v2 authority. Reauthoring also validates the fresh mutation state, rather than saving tolerant display defaults as new permission.

Draft creation validates the actual PR's repository, branch, target and head, saves its identity and confirms the save before the Developer can launch a writer. An interrupted create/save with no recorded PR searches branch-scoped history across **all** PR states, bounded at 100 rows. Unreadable, malformed, ambiguous or saturated history fails closed; an empty open-only search is never evidence that no merge occurred. An explicit `open-pr` reopen request validates the old PR, reopens it, rereads OPEN authority and saves it before any guarded code push.

A historical CLOSED, unmerged PR never grants code-write authority. Genuine unchanged wiki-only work may retain its original closed PR head. Only genuine done/wiki-only replay with an exact null-code completion receipt may instead read a clean fetched-base checkout after branch deletion; the original saved head must still equal the retained PR head, and original hardening, inputs, wiki and security/publication guards remain unchanged. This does not rewrite reviewed provenance to the current base or authorize another writer/code push.

Refused commits stay local, never pushed merely to preserve them. Job teardown prepares both checkouts' separate binary-safe index and working-tree patches (each independently applies on its recorded base), and verifies a self-contained local-code bundle and strictly preserves private wiki commits in the wiki mirror before resetting or removing either checkout. A missing, unreadable or unwritable required mirror refuses preparation. Patch preparation uses a separate index; failure leaves the original files, staging and HEAD intact, and restart refuses to overwrite the checkout. Existing recovery evidence is never overwritten. A pre-push bundle can remain after a successful push; it is inert recovery, not approval or automatic replay. Final wiki-mirror reconciliation is also strict: a later failure retains the checkout and prepared evidence, but dirty files may already have been reset and must be restored from their patches. Retain these recovery artifacts and explicitly recover or relocate the checkout before restarting; nothing automatically applies or publishes them.

Hardening and its check-fix sessions receive the actual `commands.test` and a pinned Hardening prompt directing only targeted tests inside the session; deterministic verification runs the full gate afterward. The reviewer wall-clock limit and bounded check-fix/readiness guards are unchanged. Before destructive teardown, a job-keyed `dropped/JOB_KEY.json` manifest records branch assignment, Review outcome/reason, source checkouts, snapshot kinds and bases alongside the patches. A manifest save failure retains the original checkout. Later authorized hardening writers on that issue/branch automatically receive matching Review recovery paths, independent of the replaceable `job.json` or issue notices. They inspect and incorporate useful edits within current scope, never automatically replay them. Preserve earlier attempts' evidence; caller-owned restart and all authority checks still apply. Legacy patches without manifests need explicit reconciliation rather than guessed branch provenance.

Code synchronization deterministically resolves only the enabled configured wiki gitlink to the pin in its exact fetched target, without initializing the code submodule or consulting the separate wiki checkout's moving HEAD. Wiki-only stops use no model or conflict-fix attempt. Code resolver sessions stage text and return; `finish-sync` owns continuation and later gitlink stops, returning further text stops under the existing limits. It also classifies stops reached by a session continuing code itself, before interpreting a `cannot-fix` reply or rejecting an explicit abort. `cannot-fix` can complete only through the existing finish/push guards; an explicit abort never pushes. Other gitlinks stop with full numbered-stage SHAs and retained unresolved evidence. The separate wiki flow integrates history; before an unmerged code integration is verified, `pin-wiki` commits its integrated wiki result under fresh write-authority guards. It cannot write code for wiki-only or already-merged work. Exact-head checks, actual-result checks, security and publication gates are unchanged.

Later text stops stay on the same code rebase: the next resolver gets current paths, the exact fetched target and the next cumulative attempt, without treating the earlier staged resolution as rejected. Each completed session's count is saved before continuation. At `maxConflictFixes`, code synchronization retains the stopped pick through `finish-sync {retainConflict: true}` and stops under the existing conflict control with the full pick ID, paths and verified recovery location, rather than attempting abort cleanup and surfacing a generic unmerged-index error. This preserves the saved count and synchronization context for explicit authorized recovery. Remaining eligible gitlink-only picks can still complete at the limit without another attempt; finish and guarded push checks remain mandatory.

Synchronization cleanup also saves the staged/working patches and a verified bundle containing current, local-branch and available pre-rebase history before abort/reset/clean. Wiki rejection restores the pre-rebase head rather than an older remote issue branch. An unresolved index saves the verified history bundle and `conflict-stages.json` (path, stage number, mode and full object ID), then refuses destructive cleanup and retains the original checkout, unresolved index and working files for explicit recovery. The stop names the paths and retained evidence instead of attempting lossy patch preparation. A wiki-mirror refresh updates remote-tracking refs, never private recovery heads; divergence retains both refs and refuses automatic selection.

**Concurrency limitation:** caller serialization is not external exclusion. Outside actors may push, merge, retarget or change permissions/configuration at any time. The explicit destination/immutable-source REST merge and exact-result checks above are the supported compromise, not an atomic PR/input/config transaction. Observed invalid authority refuses writes; unseen concurrent changes are not atomically prevented. No exclusion promise or credential/ruleset change is implied. Installation remains operator-owned and requires exact candidate checks and a reviewed cutover.

## Stop reconciliation evidence

Before a job launches stop, it writes a private local
`runs/<slug>/issue-N/stop-recovery/<uuid>.json` record shared with the stop child.
Stop verifies merge identity, preserves fresh signed durable authority and the
resume stage, saves and authoritatively rereads the stopped state/cleared lease,
then requires working-label removal, stop-label updates and claim closure.
Transient login failures receive only the bounded safe-read retries above;
required writes are not blindly retried. A fully acknowledged stop records
`signed-stop-confirmed`. Required cleanup failures are not ignored; a missing
label (HTTP 404) is already removed. If a signal interrupts the stop child,
the job retains this evidence instead of saving its stale working checkpoint
over a stopped state that may already have landed.

If login, a required update or the child itself fails, the record remains
`reconciliation-required` and the job reports its path. It names issue/repository,
assigned branch, resume stage/source, intended code, original and stop failures,
and confirmed versus unresolved state/lease, explanation, working-label,
stop-label and claim effects. Failure fields redact configured tokens before
truncation (8192 UTF-16 code units plus a marker per field). A lost response stays
unresolved and may have landed. Retain these files across status replacement.

Stop dispatch and reconcile every unresolved effect against fresh GitHub
state/editor provenance, lease, live claims and issue/PR labels before an
explicitly authorized restart. Preserve remote code/private-wiki commits and
existing genuine receipts. This local evidence is **not signed authority**:
passed checks or pushed commits never supply missing hardening, and ordinary
saved-authority/exact-head checks still gate recovery. No install or deployment
is implied by merging this source change.

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
| `git-review.mjs` | Credential-isolated, read-only Git queries with session-local paging and tool-result coverage records |
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
config omits the file path. Login checks use the shared safe-read backoff:
four attempts, waiting 2/4/6 seconds, with the existing 120-second command timeout.
Network/transport failures, HTTP 5xx and secondary rate limits are transient;
a named wrong login or HTTP 401 fails immediately, taking precedence over
transient text. Only successful account/token verification is cached. Errors
distinguish wrong account, authentication rejection and unverifiable identity,
with gh exit status and a stderr excerpt of at most 1024 UTF-16 code units
including the truncation indicator. Selected-token redaction precedes truncation;
empty stderr is explicit. Verification retries never repeat the requested write. Legacy live `account`/`tokenFile` config is rejected
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

Before upgrading: stop dispatch, drain all old-version jobs (prefer completing an active integration turn), verify no old job/session remains, snapshot installed config and signed state/recovery artifacts, pass the **exact source HEAD** full gate, review the candidate changes and install dry-run, then perform a controlled install and resume one explicitly assigned issue/stage at a time. When prompts change, review/publish the wiki and select the intended pinned brain separately; new jobs must still validate their stage's required pages. Never mix live old/new jobs or reset branches, hardening, integration, attempted-merge/response evidence (including cumulative reconciliation reads), security rejections or code-merge receipts to make an upgrade pass. Installing this recovery fix is a separate operator-authorized upgrade after its source merge, not an automatic source-workflow step; it performs no credential rotation, release or deployment. Unknown moved heads return conservatively to hardening; code already merged stays merged. Install/rollback of binaries does not undo code merges or publish rejected wiki work.

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

The combined gate runs at most two test files concurrently. Full-flow files launch their own jobs, ops, fake GitHub and Git subprocesses, so host-core-count parallelism can oversubscribe the machine and exhaust stage/hook deadlines. This resource budget changes neither the test selection nor any assertion or timeout. Run the combined gate rather than an unbounded parallel test invocation.

Tests use temporary HOME/pipeline roots, local bare git origins, fake GitHub and fake pi, never real GitHub/models or production data. Create/assert the temporary ROOT and set HOME/ISSUE_PIPELINE_ROOT **before dynamic source imports**: root resolution happens once on import. Full-flow regressions cover writable hardening/integration, final read-only security, wiki-only completion, explicit fresh-root invocation and claim-populated interrupted-merge replay. Legacy scheduling safety tests remain compatibility coverage, not a live dispatch recommendation. A failure or flake blocks acceptance; fix its cause rather than rerunning for a pass.
