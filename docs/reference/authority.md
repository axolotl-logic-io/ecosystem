# Authority

Authority comes from qualified human controls, trusted buddy configuration, authenticated ownership and exact-bound task evidence. A prompt, historical stage, hidden marker or local process grants none of these. The rules are in [authority decisions](../decisions/authority.md) and the [domain runtime contract](../domain-runtime-contract.md).

## GitHub accounts

The repository configuration names distinct `devAccount` and `landingAccount` logins. These authentication identities are separate from buddy roles, model profiles and human producers.

| Operation | Account |
|---|---|
| Code commits, issue-branch pushes, Sync pushes and permitted recovery pushes | Development |
| PR lifecycle and permitted source-branch effects | Development |
| Authenticated pipeline records, authority reads and issue lifecycle | Landing |
| The guarded target-branch Land effect | Landing |

Neither machine account qualifies as a human producer, even if its name appears in a trusted-input list. `legacyAccount` only classifies historical machine content for display and exclusion; it grants no authority.

`credentialsEnvFile` must be an absolute path to a regular file with no group or other permissions. A privileged call selects one token variable, verifies its login, and supplies only that token as `GH_TOKEN`. Git uses a per-call, non-storing credential helper for the configured repository. The old single-account configuration is refused.

A safe login read can retry transient failures; the operation it guards is not repeated. A wrong login or rejected token fails immediately. Exhausted identity reads remain unverifiable, not authenticated. Successful identity checks are cached only for the same account/token within that process.

## Human controls

A qualified issue-label application event can request `start:implement` or `agents:stop`. Qualification checks the producer's human identity and current policy/membership evidence. Assignment, a PR label, an App, a bot, a machine account and label removal do not supply equivalent authority.

The accepted start binds the work item's trusted requirements. An authenticated Implement attempt spends those requirements regardless of its result or a later target change. Applying the start label again does not retry it. Unknown or conflicting evidence holds work. See [stops and labels](stops-and-labels.md).

Membership-reader capability must be verified for the installed account. A passing fake transport does not establish that capability. Unavailable membership evidence holds; it does not authorize credential changes or a fallback.

## Authenticated records

Operational records must be written by the configured landing account and retain valid editor provenance. Readers fetch the body, author and edit metadata together. An edited record needs the landing account as its editor; missing, conflicting or unreadable provenance cannot be replaced by an older convenient record.

Hidden marks select record formats, not trusted authors. A diagnostic quotation is not a result. Removing a mark from a machine-authored comment does not make tampering safe to ignore. Readers paginate the relevant history rather than treating a partial page as complete evidence.

Live GitHub edit-metadata semantics still require operator verification. Source tests do not replace that check.

## Checkpoints and task results

The v4 `WORK_STATE` checkpoint preserves the assigned branch, current work and authenticated execution receipt. It is not a scheduler stage or a prerequisite pass. The v2 task records separately describe attempts and outcomes with their run, binding and provenance. See [task results](task-results.md).

A current result binds its exact code/trusted-input revision, target state and checking policy. A result for another subject cannot clear the current one. Historical state and v1 results remain conservative evidence or reconciliation barriers, never current task clearance.

A state checkpoint makes one write attempt and confirms the exact transmitted body through an authenticated read. A lost response may resolve through that read-back. An unresolved result preserves the transmitted body, record identity and execution binding in its uncertainty journal. It grants neither a repeated write nor release to a successor.

## Ownership and reservations

Issue execution binds the repository, literal base, issue, branch and invocation. A saved receipt must link to authenticated coordination history. A local UUID, matching lane name, process exit or expired lease does not replace that history or prove predecessor release.

Ownership and capacity are distinct. A model-session reservation grants no issue authority. The target's integration turn serializes permitted Land effects but supplies no prerequisite result. Unknown ownership, unresolved writes and surviving consumers retain their barriers. See [coordination](coordination.md), [reservations](reservations.md) and [checkouts](checkouts.md).

## Controlled writes

Task operations reread the trusted buddy authorization, current cause, relevant stop evidence, ownership and task-specific prerequisites at their controlled effects. The authoritative request envelope overrides payload fields. The retired assignment `grant` envelope is refused.

Source pushes, including `pipeline_commit`, require substantive write authority. A new human stop, loss of qualification, unknown stop evidence, a Security refusal or already-landed work cannot grant another code write. Evidence-only settlement uses a separate, limited recording authorization; it does not hide a substantive mutation.

Land additionally needs explicit trusted permission, exact-bound Harden/Integrate/independent Security, current required CI, an immutable strict-descendant candidate and an exact old-object lease. Complete preserves the item's original own-Land proof; observing someone else's merge cannot manufacture it. See [Land and Complete](merge.md).

## Trusted inputs and sessions

Trusted requirements use the issue and currently qualified human contributions under repository policy. Unqualified and machine contributions do not gain authority by appearing in a session prompt. A changed trusted-input revision invalidates results bound to the old one; it supplies no automatic retry or Author continuation.

A session receives only its task/profile permissions. Its name and prompt are not authorization. Sessions lose GitHub token variables, configured GitHub credential variables and inherited Git credential/config-injection settings. They run as the operator's OS user, not in a filesystem or network sandbox. A reader's tool declaration alone does not prove an unchanged local checkout. See [sessions](sessions.md) and [runtime](runtime.md).

## Recover from an authority failure

1. Hold new actions for the affected work item.
2. Preserve its authenticated history, action observations, uncertainty journals, checkouts, tracked and untracked work, patches and bundles.
3. Identify the failed evidence: credentials, human qualification, provenance, binding, ownership, reservation or an uncertain effect.
4. Reconcile the original attempt through its permitted read-only observations. Do not repeat a push, rebase, close or checkpoint to discover whether it succeeded.
5. Resume only a defined, newly authorized path. Clearing a local barrier, fixing a credential read or removing a label does not unspend a start or authorize continuation.

Source delivery does not authorize installation, activation, credential changes, unrelated interruption or work discard.
