# Gherkin task

`@ecosystem/gherkin` defines a buddy-independent task. Import `gherkin` from the
package and execute it with `executeTask` from `@ecosystem/task-framework`.
Importing the definition starts no CLI or subprocess.

## Inputs and capabilities

The strict input schema requires `issue.repository`, `issue.number`,
`issue.context`, `baseBranch` and `model`. The host supplies issue context already
filtered to trusted authors and resolves repository policy and model settings
before invocation. These inputs contain no buddy paths, credentials or implicit
runtime root.

The host provides two capabilities:

- `openRepository()` grants read access to a detached source checkout and returns
  its `directory` and pinned `revision`.
- `runModel(session)` runs one read-only model session with the supplied inputs,
  repository and task facts. The task validates its reply with the task-owned
  schema exported from `@ecosystem/gherkin/reply`.

The execution context supplies cancellation and artifact publication. The task
checks cancellation before repository access, model execution and publication.
Capability providers must also enforce their authority and stop guards. The host
owns checkout cleanup even after failure or cancellation.

## Outcomes and publication

A `gherkin` reply publishes the logical artifact `gherkin` and returns a
`completed` outcome. A `needs-info` reply publishes `questions` and returns
`needs-input`. Invalid replies fail execution and publish nothing. The result
retains the validated model reply. The task knows no GitHub marker format or
comment ids.

The installed `gherkin.mjs` remains the compatibility bootstrap. Its issue adapter
uses the [shared runtime](../../packages/task-runtime/README.md) to claim the
start, resolve policy, filter trusted issue context and provision
credential-free model execution. It updates the existing Gherkin comment and posts
a fresh questions comment on every questions reply. Claims, running labels, stop
guards, recovery markers and final reporting remain host responsibilities.

## Prompts and tests

This workspace owns `prompts/gherkin.md` and
`agents/issue-pipeline-gherkin.md`. The pipeline installer places them at their
existing installed paths. Source changes activate only after installation.

Run `npm run check --workspace @ecosystem/gherkin` for task typechecking, lint and
fake-host behavior tests. The pipeline's system tests exercise the installed CLI
against fake GitHub and models, with real local Git. Both root gates include the
task workspace; `npm run check:full` also runs all non-external pipeline tests.
