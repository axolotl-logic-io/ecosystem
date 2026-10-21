# Authority decisions

These decisions cover who and what the pipeline trusts: GitHub accounts, authority records, saved state, session authority and trusted input. [Authority reference](../reference/authority.md) describes how the code applies them.

## authenticated-authority-records

Pipeline authority comes only from records the review/merge account wrote and last edited. Hidden markers and role names are not authentication.

## separate-development-and-merge-accounts

Development and review/merge use separate GitHub accounts. Development credentials cannot approve, merge or write authority records. No model session holds either token.

## state-comment-on-the-issue

Durable pipeline state lives on GitHub, in a hidden comment on the issue, because the issue exists before any PR does. Local files are caches and recovery evidence, not authority.

## session-authority-limits

Each session gets only the tools and commit authority its stage needs, and no GitHub token. Sessions still run as the operator's OS user, so a shell can read anything that user can, including the credentials file. Tool and network declarations are not isolation; don't describe them as a sandbox.

## trusted-inputs-revision

Approvals and Security clearance record the revision of trusted inputs they relied on: the issue's title and body, plus comments from allowed users who are still collaborators. When those change, earlier approvals and clearance no longer hold, and the work returns for requirements review. Visitor and pipeline comments never change the revision.

Requirements review means the Author if the issue used one, otherwise the Developer.

Not yet implemented: the Author stage and its Gherkin comment are still mandatory, and a trusted-input change returns the issue to the Author from any stage.

## allow-listed-input

Only users on a configured, nonempty allow-list who are still collaborators count as trusted input. Visitor comments are withheld from prompts. Neither pipeline account is ever trusted human input.

Authority records are a separate check: see [authenticated-authority-records](#authenticated-authority-records).
