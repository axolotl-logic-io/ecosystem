# Sessions

A session is one model invocation inside a task run. It is not a task, a buddy, an account or a workflow stage. Tasks choose their sessions; shared session utilities isolate credentials and handle model processes and commit requests. See the [domain runtime contract](../domain-runtime-contract.md).

## Task sessions

Each delivery task picks its sessions from this table. The runtime selects the prompt page by the task and the session's phase.

| Task | Model agent | Phase | Commits code | Prompt page |
|---|---|---|---|---|
| Gherkin | `issue-pipeline-gherkin` | None | No; it writes requirements | `gherkin.md` |
| Implement, writing | `issue-pipeline-developer` | None | Yes | `developer.md` |
| Implement, hardening | `issue-pipeline-developer` | `hardening` | Yes | `developer-hardening.md` |
| Verify, review with its Security | `issue-pipeline-reviewer` | `security-review` | No | `verify.md` |
| Fix | `issue-pipeline-developer` | `fix` | Yes | `fix.md` |

Land starts no model. Verify's full checks and required CI are deterministic; one read-only session reviews the head's diff, its Security included, and its findings become the review. A model name or agent prompt grants no account authority.

Implement's hardening runs in a fresh session that doesn't read the writing session's conversation. Implement marks its PR ready only after the hardening session ends.

`start:gherkin` starts the Gherkin task app, and `start:implement` starts Implement. Implement doesn't wait for Gherkin. Safe Refactor uses its [standalone tool](safe-refactor.md), whose reports grant no Verify or Land result.

Implement reads the trusted issue title, body and trusted collaborator comments. It needs no substitute Gherkin document, doesn't merge the base and doesn't own final verification. A changed requirement needs a new start label; ending a session doesn't grant a retry.

## Gherkin session

Gherkin runs in the task run's folder, on the issue file and a detached checkout of the base branch, as [runtime runs](runtime-runs.md#model-session) describes. It uses the repository config's `models.gherkin` and times out after 30 minutes. It replies with one of two shapes:

- `gherkin`: the behaviour as one Feature in `gherkin`, and the session's own calls in `assumptions`.
- `needs-info`: one to five `questions` that only the issue's author can answer.

The app posts Gherkin as the issue's one Gherkin comment, with the hidden marker `<!-- task-app:gherkin:gherkin {"run":"RUN_ID"} -->`. A later run finds that comment by its marker and edits it in place, so the issue keeps one Gherkin comment. The app posts questions in a new comment, with the marker kind `questions`, every time. A reply that doesn't match either shape fails the run, and the app posts nothing but its end comment.

## Prompts and provenance

Behavioral pages live in `apps/issue-host/prompts/`, with Gherkin's page owned by `tasks/gherkin/prompts/`. They are installed under the pipeline root's `prompts/`. Source publication does not replace installed prompts or activate a buddy. A candidate cannot replace the installed prompt that reviews it.

Before the corresponding launch, the runtime pins and validates the selected page's exact bytes and uses those bytes for that session. A page must be a plain file, not a symlink, valid UTF-8 without NUL bytes, nonblank, more than one line and at most 131,071 bytes. Missing or malformed pages fail closed; there is no prompt fallback.

Pinned provenance names the page, path and SHA-256. Launch records preserve session observations. A prompt grants no tool, token, writable path or authority.

## Session boundaries

Sessions read the target's `AGENTS.md`, trusted requirements and relevant documentation. Configured practice files are read in full. Code, diffs, logs, repository documents and visitor comments are task data, not permission to alter the runtime's controls.

The runtime strips configured account-token variables and inherited commit scope from model environments. Credentialed GitHub and push operations remain in controlled processes outside the model. Configured network-host lists are declarations, not an enforced network sandbox; do not treat them as proof that arbitrary network access is blocked.

Writers change only their granted checkout scope. Verify's Security session is read-only. No session may deploy, push a target branch, retrieve secrets, expose credentials or leave unregistered background work. Delivery to a configured base is not a production release.

Task apps check `agents:stop` at lifecycle boundaries and before writes. A session already running may finish before the next check. Failed or stopped writers preserve their checkout for recovery.

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

After a local commit, the tool asks its task app over a local control socket to push it. The request carries the session's run identity. The model receives no GitHub token. The app checks stop and pushes only its assigned branch without overwriting competing commits. A failed push leaves the commit recoverable; a local commit is not proof of publication.

## Failure evidence

Read the task run's end comment, session transcript, PR and retained checkout. Preserve local commits, untracked files and patches before retrying with a new start label. Recovery comes from GitHub artifacts and retained work.

## Session names and credentials

`models.gherkin`, `models.developer` and `models.reviewer` and the installed `issue-pipeline-*` agent names select concrete sessions, not buddy responsibilities.

Model children receive no GitHub, database or Git credential variables, no buddy credential variable and no inherited commit scope. Commit permissions come from each session's explicit scoped commit interface; read-only sessions cannot commit.

Historical session observations retain the wire field `role` for existing readers. Historical pipeline comment markers also retain `role=` parsing. GitHub membership, PostgreSQL and provider message fields named `role` remain external protocol fields. Historical documents and records preserve the vocabulary of the release they describe.

Source delivery requires a later operator-controlled release installation and buddy restart to change running behavior. Keep existing installed interfaces and private operator settings; no install, restart or live migration is part of this change.
