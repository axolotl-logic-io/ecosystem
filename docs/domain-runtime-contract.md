# Domain runtime implementation contract

This page is the source contract for label-started task apps. Each task is a command-line program built on one shared task framework, only its start label starts it, and GitHub is the only record of earlier work. It describes the intended source, not installed behavior.

The code issues that build this model are:

- #246, the task framework and its start-label claims;
- #248, the buddy as a launcher of task apps;
- #249 to #253, which rebuild Gherkin, Implement, Verify, Fix and Land as task apps;
- #254, which removes the signal, record and coordination code they replace.

Until each lands, the reference pages under `docs/reference/` describe the code as it is. The [domain alignment inventory](domain-alignment.md#label-started-task-apps) maps the old names and records onto this model.

## Domain boundaries

A task owns its work: what it reads from GitHub, what it writes and how it continues earlier work. The task framework owns how every task starts, claims, reports and ends. A buddy pairs scope, task responsibilities and identity, and launches task apps. No component keeps a stage cursor, an inbox or saved task state.

Use these task identifiers:

| Task | Role | Start label | Result on GitHub |
| --- | --- | --- | --- |
| `gherkin` | Developer | `start:gherkin` | A Gherkin comment on the issue, or a comment with questions |
| `implement` | Developer | `start:implement` | Commits pushed to `agent/issue-N`, and a PR marked ready |
| `verify` | Gatekeeper | `start:verify` | One review submitted on the PR's head commit |
| `fix` | Developer | `start:fix` | A pushed head, thread replies, and a comment naming `start:verify` |
| `land` | Gatekeeper | `start:land` | The PR's merge commit and the closed issue |
| `refactor-safely` | Developer | None | Local reports from its standalone entrypoint |

A Developer buddy's default responsibilities are Gherkin, Implement and Fix; Safe Refactor is explicitly assigned. A Gatekeeper's are Verify and Land. New task names use verbs or name the method they follow.

## Accounts

Each buddy has its own GitHub account, and no two buddies share one. The launcher refuses to start when two buddies are configured with the same account. Each buddy makes every GitHub write through its own account, so a GitHub event's `actor` identifies the buddy that acted. Buddies may still share a model provider key.

Verify's account must differ from the account that opened the PR, because GitHub doesn't let a PR's author review it.

## Task app contract

To run a task app, run:

```bash
node "$ISSUE_PIPELINE_ROOT/TASK.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
```

- `ISSUE_PIPELINE_ROOT` is the installed pipeline's directory.
- `TASK` is the task identifier, such as `gherkin` or `implement`.
- `BUDDY_FILE` is the buddy's configuration file, which names its GitHub account and credentials.
- `OWNER/REPO#N` is the issue.

A buddy runs these programs, and an operator can run one by hand. A task app exits 0 when its run ends normally, including when it loses its claim. It exits nonzero when the run fails.

## Lifecycle

The framework runs four steps for every task run. A task supplies only the work step.

1. **Claim:** remove `start:X` and confirm that this buddy removed it.
2. **Mark:** add `agent:X:running`.
3. **Work:** run the task's work.
4. **Unmark:** remove `agent:X:running`, unless another run of `X` is still live.

If the run fails at any step after its claim, the framework posts a comment on the issue. The comment names the task, the step that failed and the error, and says to apply `start:X` again to retry. A failed run never applies the start label again itself.

## Claim

Several buddies can see the same `start:X` at once, and exactly one of them must run it. The framework claims a start in these steps:

1. Read the issue timeline, and note the latest `labeled` event for `start:X`.
2. Remove `start:X`. If GitHub says the label isn't there, another buddy took it, so end quietly.
3. Read the timeline again, and find the first `unlabeled` event for `start:X` after the event from step 1. If its `actor` is this buddy's account, the claim is won. Otherwise, end quietly.
4. If the timeline doesn't show the removal yet, read it again with a short, bounded backoff. If the claim is still unconfirmed, end and post a comment saying the start couldn't be confirmed.

A buddy that loses never touches `agent:X:running` and never posts a comment.

## Running label

`agent:X:running` shows people that a run of `X` is live. It never gates a start. If `start:X` is on the issue, a new run claims it even while another run of `X` is live, so two runs of one task can overlap.

A run that ends must not remove the label from under a later run. The framework posts a short end comment, with a hidden marker, for every run that won its claim. A run removes the label only when every claim it sees on the timeline has an end comment. After removing it, the run checks again and adds the label back if a new claim appeared. A run that crashes leaves the label in place, and a person removes it.

## Stop

`agents:stop` on the issue holds new claims and ends live runs while it's there. The framework checks for it before the claim, between lifecycle steps and before each write to GitHub. A run that sees it ends at that point, posts a comment and unmarks.

`start:X` stays on the issue while `agents:stop` is there, and the next poll claims it once someone removes `agents:stop`. Nothing is latched: removing the label is enough. A stop affects only its own issue.

## Recovery from GitHub

Every run starts by reading what earlier runs left on GitHub, and continues from there. The framework gives tasks shared readers for:

- the issue, its body and its comments;
- the branch `agent/issue-N` and its commits;
- the PR that closes the issue, with its reviews, review threads and CI status;
- the task's own earlier comments, found by hidden marker.

A run keeps no saved state, checkpoints or journals between runs. Pushed commits, open PRs, reviews and posted comments are the record. A run is safe to repeat: it works out what's still missing and does only that. A retry is a new start label, and it continues the same way as any other run.

Each task continues its earlier work this way:

- **Gherkin** finds its own earlier Gherkin comment by its hidden marker and edits it, rather than posting a second one. Questions go in a new comment.
- **Implement** starts from the head of `agent/issue-N` if the branch exists, and pushes as it goes. It opens the PR early as a draft, with `Closes #N` in the body, reuses an existing PR and marks it ready once hardening passes.
- **Verify** reports its account's existing review of the current head instead of submitting a second one. A review of an earlier head doesn't count.
- **Fix** answers only the blocking comments that have no reply from its account yet, starting from the branch's pushed commits.
- **Land** only closes the issue if the PR is already merged and the issue is still open. It never merges twice, and settles a lost merge response by reading the PR's merged state.

## Results and bindings

A task's result is the GitHub artifact it leaves, listed in the [task table](#domain-boundaries). There are no task records, receipts or attempts. A result's binding is what the artifact names:

- Verify's review is bound to the commit it was submitted on. A new head needs a new Verify.
- Land's merge is bound to the head it passed to `--match-head-commit`.
- Fix's and Implement's results are the heads they pushed.

## Task rules

Only a task's start label starts it. A review, a task result, an assignment or a status label never does. A task reads its prerequisites from GitHub when it runs, and ends with a comment that names any that are missing.

- **Gherkin** runs a read-only session that returns the Gherkin or its questions through structured output. The app posts the result.
- **Implement** writes the change, hardens it in a fresh session and marks the PR ready once hardening passes. It doesn't wait for an assigned person or for Gherkin.
- **Verify** reviews the head of the PR that closes the issue, as it is when the run starts. It runs the full checks, waits for the required CI and runs the Security review on that head. It submits one review: an approval when it finds nothing or only nits, and a request for changes otherwise. A Security finding always blocks.
- **Fix** merges the PR's base branch into the head branch and never rebases. It answers every unresolved blocking comment on the current head with a code change and a reply in the comment's thread, pushes the new head and posts a comment naming `start:verify`.
- **Land** merges with `gh pr merge PR --merge --match-head-commit HEAD`, so GitHub refuses the merge if the head moved. There is no squash, rebase or admin bypass. If the PR conflicts, Land marks it as a draft and posts a comment naming `start:fix`. After the merge, it closes the issue if the merge didn't.

Land's prerequisites, all read on the current head, are:

- an approval from Verify's account or a person with write access;
- no standing request for changes;
- green required CI;
- a head that contains the base.

### Review loop

An issue gets at most three Fix rounds that Verify triggered. Fix counts them from the PR's reviews by Verify's account, not from task records. After the third, Fix ends with a comment asking a person to step in. A person's review or Land's conflict doesn't count toward the limit.

## Trust

Only accounts with triage access or higher can add labels to an issue, so a start label being present is enough to start its task. The framework doesn't check who applied it.

Issue and PR text from other people is still untrusted input to model sessions. Fix and Land act only on reviews from Verify's account or a person with write access.

## Buddy launcher

The buddy is a launcher. It polls the repositories in its scope for open issues with a `start:X` label, where `X` is one of its tasks. For each one, it runs that task's app with the issue.

- It checks no prerequisite first, including `agent:X:running` and earlier results. The app's claim decides which buddy runs a start.
- It runs every start it sees, so two runs of the same task on one issue can overlap.
- It keeps running when an app fails. It logs the app's exit status and leaves the reporting to the app.

A buddy file names its scope, its tasks, its single GitHub account and the credential file entry for that account.

## Run records

The framework writes one run record for each run that wins its claim, so that the workflow dashboard (`apps/workflow-dash/`) can keep showing runs. A run that loses its claim writes nothing. Run records are observations, never authority: no run reads them to decide what to do.

## Safe Refactor

Safe Refactor keeps its standalone entrypoint, `safe-refactor.mjs`. It has no start label and no task app, and its reports grant no workflow result.

## Removed components

These components of the earlier contract have no place in this model. #254 removes their code once every task has moved.

### Signals

The signal inbox, qualification of a label's producer, accepted-signal records, spent starts and durable stop latches are gone. A start label on the issue is the whole start signal, and a [claim](#claim) replaces acceptance and spending. `agents:stop` holds only while it's on the issue, as described under [Stop](#stop).

### Task records

Task attempts, results, receipts, bindings and readiness rules are gone. Results are the GitHub artifacts described under [Results and bindings](#results-and-bindings). Read-only recovery handlers are replaced by every run's [recovery from GitHub](#recovery-from-github).

### Reservations

Runtime admission, activation and the model-session, test-slot and target-write reservations are gone from the delivery workflow, along with journals, epoch refs, saved state, write authority, lane slots and locks. The launcher runs every start it sees, and GitHub's `--match-head-commit` check guards Land's merge.
