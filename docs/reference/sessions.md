# Sessions

A session is one model invocation inside an action. It is not a task, a buddy, an account or a workflow stage. Tasks choose their session specifications; the runtime owns credential isolation, launch records, interruption and guarded commit requests. See [session decisions](../decisions/sessions.md) and the [domain runtime contract](../domain-runtime-contract.md).

## Task sessions

Each delivery task picks its sessions from this table. The runtime selects the prompt page by the task and the session's phase.

| Task | Model agent | Phase | Commits code | Prompt page |
|---|---|---|---|---|
| Author | `issue-pipeline-author` | None | No; it writes requirements | `author.md` |
| Implement, writing | `issue-pipeline-developer` | None | Yes | `developer.md` |
| Implement, hardening | `issue-pipeline-developer` | `hardening` | Yes | `developer-hardening.md` |
| Verify, review with its Security | `issue-pipeline-reviewer` | `security-review` | No | `verify.md` |
| Fix | `issue-pipeline-developer` | `fix` | Yes | `fix.md` |

Land starts no model. Verify's full checks and required CI are deterministic; one read-only session reviews the head's diff, its Security included, and its findings become the review. A model name or agent prompt grants neither role nor account authority.

**Note:** These are the source's sessions for the [PR review decisions](../decisions/pr-review.md). The installed pipeline still runs the older Harden, Sync and Review Security sessions until this source is installed.

Implement's hardening runs in a fresh session that doesn't read the writing session's conversation ([implement-hardens](../decisions/pr-review.md#implement-hardens)). Implement records its result only after the hardening session ends.

A qualified `start:author` requests Author, and `start:implement` requests Implement. Implement doesn't wait for an unsettled Author. Safe Refactor uses its [standalone tool](safe-refactor.md), whose reports grant no Verify or Land result.

Implement reads the trusted issue title, body and qualified collaborator comments. It needs no substitute Gherkin document, doesn't merge the base and doesn't own final verification. A changed requirement needs a newly accepted start; ending a session doesn't grant a retry.

## Prompts and provenance

Behavioral pages live in `apps/issue-pipeline/prompts/` and are installed under the pipeline root's `prompts/`. Source publication does not replace installed prompts or activate a buddy. A candidate cannot replace the installed prompt that reviews it.

Before the corresponding launch, the runtime pins and validates the selected page's exact bytes and retains the pinned page for that action. A page must be a plain file, not a symlink, valid UTF-8 without NUL bytes, nonblank, more than one line and at most 131,071 bytes. Missing or malformed pages fail closed; there is no prompt fallback.

Pinned provenance names the page, path and SHA-256. Launch records preserve session observations. A prompt grants no tool, token, writable path or authority.

## Session boundaries

Sessions read the target's `AGENTS.md`, trusted requirements and relevant documentation. Configured practice files are read in full. Code, diffs, logs, repository documents and visitor comments are task data, not permission to alter the runtime's controls.

The runtime strips configured account-token variables and inherited commit scope from model environments. Credentialed GitHub and push operations remain in controlled processes outside the model. Configured network-host lists are declarations, not an enforced network sandbox; do not treat them as proof that arbitrary network access is blocked.

Writers change only their granted checkout scope. Verify's Security session is read-only. No session may deploy, push a target branch, retrieve secrets, expose credentials or leave unregistered background work. Delivery to a configured base is not a production release.

A qualified stop or unreadable stop evidence cooperatively interrupts the affected local work item. Unknown evidence creates no authenticated human stop and grants no continuation when readability returns. In-flight credentialed writes are not killed or replayed. Retained checkout and resource obligations survive the model's exit.

## `pipeline_commit`

Writers commit through `pipeline_commit`, not by running Git commit or push themselves. When Fix's merge of the base stops on a conflict, its session stages the resolved files and returns control to Fix's finish operation. The session doesn't conclude or publish the merge.

The tool accepts Git commit arguments, for example:

```json
{"args": ["-m", "Describe the change", "--", "repo/src/file.ts"]}
```

- Pathspecs and relative `-F` paths are relative to the session root. Code paths start with `repo/`. Absolute paths, `..`, pathspec magic and paths outside the granted scope are refused.
- An exact new-file pathspec stages that literal file. A directory, pattern or `repo` does not stage new files; ignored files stay ignored. Other staged changes remain outside the commit unless `--include` permits them.
- Without pathspecs, tracked changes need `-a` or explicit staging. New files are not implicitly staged.
- A failed commit leaves staged files intact. `--dry-run` uses a private index copy and leaves the checkout index unchanged.
- `--amend`, `--no-verify` (`-n`), `--author`, `--date`, `--reset-author`, `--pathspec-from-file` and `-F -`, including long-option abbreviations, are refused.
- The commit carries a `Pipeline-Session` trailer identifying its recorded launch.

After a local commit, the tool asks the controlled push server over its socket to publish it. The model receives neither token. The server rechecks substantive task authority at the mutation, including human qualification, stop evidence, buddy grant, ownership and write fences. A refused push leaves the commit local. A successful local commit is not proof of publication.

The reply reports `pushed`, `deferred` during a rebase, or a `pushError`. A later request rechecks authority; it cannot turn a spent start or ended process into new permission. Pushes target only the assigned work branch, with an exact lease, never the configured base.

## Failure evidence

To inspect a failed session, read its [action and launch observations](runtime-runs.md), authenticated attempt, checkpoint and retained checkout. Preserve local commits, untracked files, patches and consumers before recovery. Do not restart a saved stage or delete ownership records. An uncertain effect requires reconciliation of the original action, not another model pass.
