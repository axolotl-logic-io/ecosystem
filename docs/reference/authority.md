# Authority

This page describes how the pipeline decides what is authoritative: its two GitHub accounts, authority records, saved state, claims, trusted input and session authority. The rules are in [authority decisions](../decisions/authority.md).

## Two GitHub accounts

The configuration names distinct `devAccount` and `mergeAccount` logins. These are authentication identities, not the Author, Developer and Reviewer model roles.

| Operation | Account |
|---|---|
| Code commits; issue-branch, sync and recovery pushes | Development |
| PR create, edit, reopen, close, ready and draft; source-branch deletion | Development |
| Every pipeline comment: state, claims, Gherkin, review and Security results, usage records, receipts | Review/merge |
| Labels, issue lifecycle, authority reads, CI and status reads | Review/merge |
| GitHub `APPROVE` review of the exact head, and the branch merge | Review/merge |

When a PR action also needs a comment, development does the action and review/merge posts the comment.

`credentialsEnvFile` must be an absolute path to a regular file with no group or other permissions. Each call reads only its selected variable, `ISSUE_PIPELINE_DEV_GITHUB_TOKEN` or `ISSUE_PIPELINE_MERGE_GITHUB_TOKEN`, and exports nothing else. The old single-account `account` and `tokenFile` fields are refused. Optional `legacyAccount` only classifies an earlier machine account's comments for display and trusted-input exclusion; it grants nothing.

Privileged calls get only their selected token as `GH_TOKEN`. Git uses a per-call, non-storing credential helper for the configured repository, with no global helper.

### Login verification

Before an account's first use in a process, the pipeline checks the token's login.

- Network and transport failures, HTTP 5xx and secondary rate limits are retried as a safe read: 4 attempts in total, waiting 2, 4 and 6 seconds, each command with a 120-second timeout.
- A different login fails at once as a wrong account; HTTP 401 fails at once as rejected authentication. These take precedence over transient text.
- Exhausted retries report the identity as unverifiable after 4 attempts.
- Error text redacts the token, then keeps at most 1024 UTF-16 code units of stderr.
- Only a successful check is cached, for that account and token in that process. Retrying verification never repeats the operation it guards.

## Authority records

Authority comes only from comments the review/merge account wrote and last edited. For each such comment, the reader fetches body, author, `lastEditedAt` and `editor` together in one GraphQL query.

- An unedited comment must have no edit time and no editor.
- An edited comment must have the review/merge account as editor.
- Another editor, a missing field or a failed read stops for reconciliation.
- Review/merge comments whose markers were removed are still checked, so a tampered newest state can't be skipped in favor of an older one.

Hidden markers and role names are metadata. A diagnostic comment that quotes a state marker is not a state comment.

**Note:** The GitHub semantics of `lastEditedAt` and `editor` still need live operator verification, for example with a disposable edit, marker removal and deletion. Until then, treat this check as unverified against GitHub.

## Saved state

The issue's state lives in a hidden review/merge comment on the issue. It records the stage, the assigned branch, the PR, counts, and receipts such as hardening, integration, merge and Security results.

- The first claim binds the issue to its branch. A different branch on resume is refused.
- Missing or malformed critical state refuses writes. It is not permission to start over on top of preserved work.
- Only a truly new issue can get a first claim. Earlier pipeline comments, local work, run files or branches without saved authority need reconciliation instead.
- Legacy v1 state is display-only; a claim over it fails with `legacy pipeline state needs explicit reconciliation`.

## Explicit execution state seam

`src/execution-state.ts` provides an explicit-only API for authenticated state checkpoints. Default jobs, ops, orchestration and reporting do not import it. This preparatory seam is not runtime fencing, claim eligibility, setup, teardown or release, and it is not an install candidate. Lane resource leases do not grant invocation ownership.

- `readExecutionClaimState(config, issue)` validates the explicit execution binding and reads supported saved state without changing it. Existing state needs a strict `{ protocol: 1, request, instance }` receipt linked to an authenticated request and owner confirmation for the exact repository, literal base, issue and branch. A current UUID must also match its authenticated lane. A different historical UUID needs a durable release; its old lease's age grants nothing.
- `claimExecutionState(config, issue)` inspects state before requesting ownership, acquires through the existing authenticated adapter, and checkpoints the current receipt. It preserves the saved stage and work; it does not apply broad claim transitions or run setup. Only genuinely absent work can initialize state. Unsupported, malformed, untrusted, editor-conflicted or history-less authority requires reconciliation, not adoption.
- `saveExecutionState(config, issue, state)` requires fresh current ownership and a current saved receipt. It validates both saved and requested branch bindings and retains the PR, non-erased head, attempted/observed merge facts, own-merge attempt authorization and durable Security decisions across stale role snapshots.

  Observed merge SHAs cannot be replaced by snapshots. Exact own-merge receipts retain their inputs, policy and historical wiki provenance; stale snapshots also retain historical recovery authorization without an attempt receipt. An external merge without an own-merge attempt can still receive fresh hardening for changed trusted inputs and save the independently hardened result revision.

  Explicit head changes remain possible through the existing authorized push/adopt/sync flow; it does not freeze every non-null historical head. Existing draft validation and merge authorization rules are unchanged.

A checkpoint makes one mutation attempt and confirms the exact transmitted body with body, author and editor provenance from the same authenticated read. A lost response can resolve through that exact read-back. An unresolved result retains the exact body, comment identity and execution binding in `coordination-uncertain.json`. It permits neither writer assertion nor release, and a later invocation cannot repeat the mutation for progress. Preserve the journal and durable history for explicit reconciliation; neither local evidence nor historical receipts grant current ownership.

Receipt-less historical v2 state remains readable through the compatibility reader, but cannot grant execution through this seam. New revisions omit wiki writes. Historical non-null wiki revision values retain their conservative meaning and cannot become clearance for a wiki-free revision by omission.

## Claims and leases

A job claims an issue with a comment, reads the comments back, and proceeds only if its claim is the earliest live one. A claim is live until it is closed or goes `leaseHours` (default 3) without an edit.

- Pass the same stable `--lane` to every stage of an issue. Without it, each job is a new claimant and can't take a still-live earlier claim.
- A job saved at another stage releases the issue without running its model.
- Claims and leases don't stop outside GitHub actors, and they don't make PR, ref or input changes atomic.

## Write authority

Every credentialed code push checks fresh saved authority and the PR's actual status first. That includes `pipeline_commit` pushes, synchronization and stop-time salvage.

- A saved or observed code merge, a Security rejection or missing critical state grants no code write.
- Synchronization checks authority before it resets or rebases local work, and again before it pushes.
- A historical closed, unmerged PR grants no code write.

## Trusted input

Each repository must set a nonempty `allowedUsers` list; a missing or empty list is refused. A human counts as trusted input only while on that list and still a collaborator.

- Comments from anyone else are withheld from the issue text sessions read, with a note counting them.
- Neither pipeline account is ever trusted input, even if listed.
- The trusted-input revision is a hash over the issue's title and body and the trusted comments. Visitor comments and pipeline comments never change it.
- A changed revision voids approvals given on the old one. It returns authored work to Author and direct work to Developer for requirements review. Saved states without `authorUsed` remain authored; they are not reset to select a new mode.

## Session authority

A session's authority comes from its stage, its phase and whether it commits, never from the agent's name or its prompt. See [sessions](sessions.md).

- No session holds a GitHub token. Sessions lose `GH_TOKEN`, `GITHUB_TOKEN`, both pipeline token variables, every configured `jobRoles.*.tokenEnv`, and inherited Git askpass, config-injection and trace settings.
- Network lists in the job boundary are recorded, not enforced.
- Sessions run as the operator's OS user. A shell can read anything that user can, including the credentials file.
- Pi's tool allowlist has a codemode exception: when `--tools` names no `mcp__` tool, tools of configured MCP servers stay callable through codemode. Launches load no ambient extensions or MCP settings, but adding an MCP-capable extension would widen every role, including read-only sessions.

## Recover from an authority failure

1. Stop dispatching the issue.
2. Read the error. A wrong account, rejected token or unverifiable identity is a credentials problem; fix the operator file or the account, not the pipeline state.
3. For a provenance failure, read the issue's review/merge comments and their edit history on GitHub. Find out who edited what.
4. Keep every comment, local run file and branch. Don't delete traces to make the issue look new; the claim can't tell that from first use.
5. Restart the same issue, branch and lane only after the saved state reads as genuine. Legacy or untrusted state needs explicit reconciliation; there's no automatic adoption.

## Explicit bound claims

The source-only `boundClaim` API in `src/ops/bound-claim.ts` connects the explicit
execution-state seam to claim transitions and checkout setup. It is not imported
by the default job or ops CLI. Caller activation and mandatory execution envelopes
remain separate work; the existing CLI claim path is compatibility behavior, not
runtime fencing.

A bound resume requires a fresh execution identity, authenticated saved receipt
and history, and a verified predecessor release. The same lane and an expired
lease do not substitute for release. After acquiring ownership, the claim
rereads authenticated state and derives its resume transition from that confirmed
checkpoint, not its earlier issue-context snapshot. A newly visible unanswered
question or ineligible closed-Merge state holds progress rather than being reset.
This is a fresh-read guard, not an atomic GitHub snapshot.

Unresolved coordination journals or local stop-recovery records block progress.
A stop's success flag is insufficient: its state, lease, claim and recorded
issue/PR effect groups must all retain confirmed acknowledgments. The stop keeps
its intended issue and PR targets separately from those acknowledgments, so a
missing PR effect group cannot silently remove that PR from recovery. Missing or
malformed effects or target lists require reconciliation, including older local
records without a target list. Confirmed stop recovery only removes a barrier;
it never supplies execution authority.

A failed lane setup keeps its
checkout, slot, signed receipt and readiness barrier. Explicit reconciliation
must resolve readiness before another bound claim can use that checkout.

The API retains assigned branch/head, draft PR, merge facts, own-merge receipts
and Security evidence while applying the existing resume transitions. Answered
questions retain their saved `asked` revision for downstream input handling.
Closed issues must prove exact incomplete-Merge eligibility before reopen;
reopening grants no writer, merge, approval or Security permission. Missing PR
metadata and unreadable authority fail rather than being treated as fresh work.
A deterministic claim rechecks its observed PR and merge result before saving
new merged truth. If the observation changes, the claim stops for reconciliation.
Ordinary role-snapshot saves still cannot establish new merge facts or clear
existing receipts. Observing an external merge does not create an own-merge
receipt, hardening or Security clearance.
Source delivery does not authorize installation, worker activation or dispatch.
