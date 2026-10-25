# Authority decisions

These decisions cover who and what the pipeline trusts: GitHub accounts, authority records, saved state, session authority and trusted input. [Authority reference](../reference/authority.md) describes how the code applies them.

## signal-authority

Decided by Autumn during the factory alignment discussion. These rules describe the intended model, not installed behavior.

A [signal](../../GLOSSARY.md#signal) encapsulates evidence of a detected condition or occurrence and its human or machine provenance. It need not be an explicit request. Tasks match signals to actions.

A human-produced signal qualifies only when its producer is a current member of the configured organization. Verify the producer's identity and current membership when starting a run and immediately before privileged effects that rely on that signal. Membership when the signal was produced is not sufficient. Machine-produced signals qualify through the applicable authentication, provenance and binding rules for their evidence, not through human organization membership. Unknown authority evidence grants no permission; work that relies on it holds.

For a label-based signal, verify the application event and the account that applied it. Label presence alone is not evidence of authority. This rule applies to human-produced label signals, including start and stop signals. Signal qualification encapsulates human and machine authority checks; tasks do not implement separate producer-specific policies.

Signal authority does not replace scope, responsibility, task prerequisites, ownership, capacity or action-specific authorization checks. It does not change the rules for trusted requirements and comments or authenticated machine-written authority records.

## label-signals

Decided by Autumn during the factory alignment discussion. These rules describe the intended model, not installed behavior.

- Adding `start:implement` requests the Implement task. Task names use verbs.
- Adding `agents:stop` requests a graceful stop for the issue. No new task runs start; active runs stop at the next safe boundary, preserve work and record checkpoints. The stop neither discards work nor undoes completed effects.
- Removing a label is never a signal. Removing `start:implement` does not cancel accepted work. Removing `agents:stop` does not authorize continuation.

Retain the provenance of an accepted signal so later checks do not depend on the label remaining present. The continuation signal, retry coverage of an accepted start request and the remaining verb task names still need decisions. Do not infer them from label removal or invent new control labels.

These signal rules replace assignment events as the intended start and stop controls. The [assignment-permission decision](buddies-and-tasks.md#assignment-permission) describes the earlier assignment-based model; migrating its permission checks and persisted records remains implementation work.

## authenticated-authority-records

Pipeline authority comes only from records the review/merge account wrote and last edited. Hidden markers and role names are not authentication.

## separate-development-and-merge-accounts

Development and review/merge use separate GitHub accounts. Development credentials cannot approve, land or write authority records. No model session holds either token.

## state-comment-on-the-issue

Durable pipeline state lives on GitHub, in a hidden comment on the issue, because the issue exists before any PR does. Local files are caches and recovery evidence, not authority.

## session-authority-limits

Each session gets only the tools and commit authority its stage needs, and no GitHub token. Sessions still run as the operator's OS user, so a shell can read anything that user can, including the credentials file. Tool and network declarations are not isolation; don't describe them as a sandbox.

## trusted-inputs-revision

Approvals and Security clearance record the revision of trusted inputs they relied on: the issue's title and body, plus comments from allowed users who are still collaborators. When those change, earlier approvals and clearance no longer hold, and the work returns for requirements review. Visitor and pipeline comments never change the revision.

Requirements review means the Author if the issue used one, otherwise the Developer.


## allow-listed-input

Only users on a configured, nonempty allow-list who are still collaborators count as trusted input. Visitor comments are withheld from prompts. Neither pipeline account is ever trusted human input.

Authority records are a separate check: see [authenticated-authority-records](#authenticated-authority-records).
