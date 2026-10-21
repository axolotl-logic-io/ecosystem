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
- A changed revision voids approvals given on the old one. Today it returns the issue to the Author from any stage.

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
