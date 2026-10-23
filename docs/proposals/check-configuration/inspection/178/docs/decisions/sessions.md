# Session decisions

These decisions cover what model sessions do and where their instructions come from. [Sessions reference](../reference/sessions.md) describes the stages, roles, prompts and commit tool.

## implementor-owns-the-change

The Developer owns the change: code, tests and affected docs. Preserve useful existing branch work instead of restarting.

## unrelated-fixes-allowed

The Developer may make improvements necessary for the task or directly connected to touched code, within its existing write scope. File independent work separately.

## prompts-ship-with-code

Version role prompts with the pipeline code they instruct. Keep them as Markdown and snapshot the exact text each job uses. A change must not replace the prompts used to review that same change.

Prompts take effect with the installed release, never at merge.
