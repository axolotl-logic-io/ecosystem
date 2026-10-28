# Authority

Authority comes from qualified human controls, trusted buddy configuration, authenticated ownership and exact-bound task evidence. A prompt, historical stage, hidden marker or local process grants none of these. The [domain runtime contract](../domain-runtime-contract.md) sets out the interfaces.

## GitHub accounts

The repository configuration names distinct `devAccount` and `landingAccount` logins. These authentication identities are separate from buddy roles, model profiles and human producers.

| Operation | Account |
|---|---|
| Code commits, issue-branch pushes, Fix pushes and permitted recovery pushes | Development |
| Opening the PR, Fix marking it ready, and permitted source-branch effects | Development |
| Fix's replies on review threads | Development |
| Its own issue assignment while Implement or Fix runs, and its removal when the action releases the issue | Development |
| Authenticated pipeline records, authority reads and issue lifecycle | Landing |
| Verify's PR reviews and their comments | Landing |
| Land's merge of the PR, its close of the issue, and marking a conflicting PR a draft | Landing |

GitHub doesn't let a PR's author approve or request changes on it. The development account opens and pushes the PR, so Verify's reviews and Land's merge come from the landing account. Only the landing account records attempts and results, for Developer tasks as well as Gatekeeper ones.

Neither machine account qualifies as a human producer, even if its name appears in a trusted-input list. Neither account's PR review is a human review signal.

**Note:** The installed pipeline still lands with a fast-forward push to the base through the landing account. The PR merge, the Verify reviews and Fix are the source's decided design and run only once installed.

`credentialsEnvFile` must be an absolute path to a regular file with no group or other permissions. A privileged call selects one token variable, verifies its login, and supplies only that token as `GH_TOKEN`. Git uses a per-call, non-storing credential helper for the configured repository. The config must name both accounts; there is no single-account mode.

A safe login read can retry transient failures; the operation it guards is not repeated. A wrong login or rejected token fails immediately. Exhausted identity reads remain unverifiable, not authenticated. Successful identity checks are cached only for the same account/token within that process.

## Human controls

A qualified issue-label application event can request `start:author`, `start:implement`, `start:verify`, `start:fix`, `start:land` or `agents:stop`. A qualified person's submitted review on the issue's linked PR is a signal too. Qualification checks the producer's human identity and current policy/membership evidence. Assignment, a PR label, an App, a bot, a machine account and label removal don't supply equivalent authority.

An accepted Author or Implement start binds the work item's trusted requirements. A Verify start binds the linked PR's head. An authenticated Implement attempt spends its requirements regardless of its result or a later target change. Applying the start label again doesn't retry it. Unknown or conflicting evidence holds work. See [stops and labels](stops-and-labels.md).

Membership-reader capability must be verified for the installed account. A passing fake transport does not establish that capability. Unavailable membership evidence holds; it does not authorize credential changes or a fallback.

## Authenticated records

Operational records must be written by the configured landing account and retain valid editor provenance. Readers fetch the body, author and edit metadata together. An edited record needs the landing account as its editor; missing, conflicting or unreadable provenance cannot be replaced by an older convenient record.

Hidden marks select record formats, not trusted authors. A diagnostic quotation is not a result. Removing a mark from a machine-authored comment does not make tampering safe to ignore. Readers paginate the relevant history rather than treating a partial page as complete evidence.

Live GitHub edit-metadata semantics still require operator verification. Source tests do not replace that check.

## Checkpoints and task results

The v4 `WORK_STATE` checkpoint preserves the assigned branch, current work and authenticated execution receipt. It is not a scheduler stage or a prerequisite pass. The v2 task records separately describe attempts and outcomes with their run, binding and provenance. See [task results](task-results.md).

A current result binds its exact code/trusted-input revision, target state and checking policy. A result for another subject cannot clear the current one. Saved state other than v4 and task records other than v2 hold the work item until an operator reconciles them; they never clear a task.

A state checkpoint makes one write attempt and confirms the exact transmitted body through an authenticated read. A lost response may resolve through that read-back. An unresolved result preserves the transmitted body, record identity and execution binding in its uncertainty journal. It grants neither a repeated write nor release to a successor.

## Ownership and reservations

Issue execution binds the repository, literal base, issue, branch and invocation. A saved receipt must link to authenticated coordination history. A local UUID, matching lane name, process exit or expired lease does not replace that history or prove predecessor release.

Ownership and capacity are distinct. A model-session reservation grants no issue authority. The target's integration turn serializes permitted Land effects but supplies no prerequisite result. Unknown ownership, unresolved writes and surviving consumers retain their barriers. See [coordination](coordination.md), [reservations](reservations.md) and [checkouts](checkouts.md).

## Controlled writes

Task operations reread the trusted buddy authorization, current cause, relevant stop evidence, ownership and task-specific prerequisites at their controlled effects. The authoritative request envelope overrides payload fields.

The cause is checked by task. Author and Implement need a qualified human start. Every other task's cause is either an authenticated result record, `result:N`, or an accepted human signal that still qualifies when the operation rereads it.

Source pushes, including `pipeline_commit`, require substantive write authority. A new human stop, loss of qualification, unknown stop evidence or work a Land may already have delivered can't grant another code write. A Land that is unsettled or passed fences code writes, because its merge may be on the base. A Land that settled without merging, such as one that found a conflict and marked the PR a draft, leaves code writable for Fix. Evidence-only settlement uses a separate, limited recording authorization; it doesn't hide a substantive mutation.

Land additionally needs explicit trusted permission, an approval standing on the exact head, no standing request for changes, a head that contains the base, and green required CI on that head. Its merge passes the checked head, so GitHub refuses it if the head moved. See [Land](merge.md).

## Trusted inputs and sessions

Trusted requirements use the issue and currently qualified human contributions under repository policy. Unqualified and machine contributions do not gain authority by appearing in a session prompt. A changed trusted-input revision invalidates results bound to the old one; it supplies no automatic retry or Author continuation.

A session receives only its task/profile permissions. Its name and prompt are not authorization. Sessions lose GitHub token variables, configured GitHub credential variables and inherited Git credential/config-injection settings. They run as the operator's OS user, not in a filesystem or network sandbox. A reader's tool declaration alone does not prove an unchanged local checkout. See [sessions](sessions.md) and [runtime](runtime.md).

## Recover from an authority failure

1. Hold new actions for the affected work item.
2. Preserve its authenticated history, action observations, uncertainty journals, checkouts, tracked and untracked work, patches and bundles.
3. Identify the failed evidence: credentials, human qualification, provenance, binding, ownership, reservation or an uncertain effect.
4. Reconcile the original attempt through its permitted read-only observations. Do not repeat a push, merge, review, close or checkpoint to discover whether it succeeded.
5. Resume only a defined, newly authorized path. Clearing a local barrier, fixing a credential read or removing a label does not unspend a start or authorize continuation.

Source delivery does not authorize installation, activation, credential changes, unrelated interruption or work discard.
