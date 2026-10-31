# Authority

Each buddy has its own GitHub account and a private credential file entry. Its task apps use that account for GitHub writes. The launcher refuses another buddy file in the same folder that names the same account. See [buddy configuration](runtime-runs.md#launcher-buddy-file).

A `start:TASK` label is the only start authorization. The framework claims it by removing it and confirming its own account on the issue timeline. Running labels indicate activity; they grant no work ownership and do not exclude overlapping runs. `agents:stop` is checked directly, with no saved latch.

Tasks recover from pushed commits, PRs, comments and reviews on GitHub. They keep no state of their own. Local run records are observations only.

## Trusted inputs and sessions

Issue and comment text from the configured allow-list is checked against current collaborator access before it becomes trusted model context. Other text is untrusted data. GitHub reads must be complete; an unreadable listing is an error, not an empty result.

Models receive no GitHub token. Writer sessions commit through `pipeline_commit`; the task app owns the push and checks stop before credentialed writes. Each run uses a private checkout, and branch pushes cannot overwrite competing commits. This is configuration isolation, not an OS sandbox: same-user files can still be readable.

A repository config names `devAccount`, `landingAccount` and `credentialsEnvFile`. Implement refuses unless the buddy's account is `devAccount`, and it names `devAccount` as the commit author when the config sets no Git identity. Comment authority and Fix's round count trust reviews from `landingAccount` unless `verifyAccount` is set. `credentialsEnvFile` holds the tokens of those two accounts for mirror fetches, shared repository readers and the standalone Safe Refactor and standards upgrade tools. These fields do not choose a task app's write account. The buddy credential chooses that account. Verify's account must differ from the PR author's.
