# Buddy and task decisions

These decisions settle the domain contracts that the [shared glossary](../../GLOSSARY.md) left open. They describe the intended model, not installed behavior. The [domain alignment inventory](../domain-alignment.md) maps them onto the installed release.

Most were made on 2026-10-22, and the rest on 2026-10-24. Each one says who decided it:

- **Autumn** decided it herself.
- **Autumn approved** means she accepted a recommendation the operating session made.
- **Delegated** means Autumn asked the operating session to decide and record it for her later review. A delegated decision holds until she changes it.

## buddy-replaces-actor

Decided by Autumn.

A buddy has a role, which is the set of tasks it's responsible for, and an identity. Buddy replaces actor; actor survives only in historical text.

A buddy has no lasting run. Each buddy run performs one task, such as Implementation, Hardening or Sync, for one binding. For now the caller decides what each buddy needs and assigns its runs by hand. Later a buddy may scan for work itself.

## sync-is-a-task

Autumn named Sync as a task. Its contract is delegated.

Sync moves out of Integration and becomes its own task:

- **Prerequisites:** a revision R and a target state T that R doesn't yet contain.
- **Result:** a new revision R′ that contains T, or a stop that names the conflicts it couldn't resolve.

Integration no longer changes the revision. It only checks R on T, and R must already contain T. A Sync result needs fresh Hardening for R′, as before.

This separates the task that writes from the task that checks, so each run holds only the access its task needs.

## two-buddies

Delegated. Autumn decided that Lawd owns Security and Land. She leaned toward giving Hardening to Hippy, and this decision adopts that.

| Buddy | Role | Tasks | GitHub account |
| --- | --- | --- | --- |
| Hippy | Developer | Author, Implementation, Hardening, Sync | `axolotl-logic-hippy` |
| Lawd | Gatekeeper | Integration, Security, Land, Completion | `axolotl-logic-lawd` |

Integration belongs to the Gatekeeper so that the side that lands also verifies, separately from the side that writes. Completion belongs to the Gatekeeper because it follows Land's receipt.

The roles stay separate from the buddies. Moving a task to another buddy changes the role's task list, not any identity or account.

## hardening-stays-independent

Delegated.

The Developer both implements and hardens, so Hardening's independence comes from how its run is scoped:

- A Hardening run starts a new session. It never continues the Implementation run's session, and it doesn't read that run's conversation.
- It works only from the revision, the requirements and the checks.
- It still tries to break the change and fixes what it finds. It must not weaken tests, checks, lint or types to get a pass.

Hardening is a quality task, not a trust boundary. The trust boundary is Integration, Security and Land, which run under the Lawd account. Security and Hardening keep separate buddies, identities and accounts.

Moving Hardening to Hippy doesn't change who records results. The development account writes code and produces evidence, but it never writes a result, receipt or checkpoint that grants authority. The landing-account process records those, as [authenticated-authority-records](authority.md#authenticated-authority-records) requires.

This replaces the Reviewer buddy of `reviewer-hardens-before-merge` in [delivery decisions](delivery.md). The installed `review` stage still runs under the Lawd account until it moves.

## least-privilege-per-task

Delegated.

An access profile is part of an identity. Each task names the access profile it needs, and its run gets only that profile, even when its buddy's identity holds more.

| Access profile | Installed name | Tasks | What it allows |
| --- | --- | --- | --- |
| Reader | `reader` | Integration, Security | Read the repository and GitHub. No write credential reaches the run. |
| Writer | `writer` | Author, Implementation, Hardening, Sync | Push the work item's branch and update its pull request, through the development account. |
| Lander | `merger` | Land, Completion | Approve the exact revision, land it, and record completion, through the landing account. |

No model session holds a GitHub token, as [authority decisions](authority.md) already require. The process around the session uses the credential.

An access profile limits the task's run, not the recording of its result. A Reader run gets no write credential. A separate recorder, the landing-account process, persists its result afterwards.

## identity-schema

Delegated. This settles open question 1.

The parts stay decoupled. Each part changes without changing the others.

- **Role:** a name and a set of tasks. It holds no credentials.
- **Buddy:** a name, one role and one identity.
- **Identity:** a name, its accounts, its model and runtime settings, its access profiles and its network policy.
- **Account:** a provider, such as GitHub or a model provider, and the login or key name there. Several identities may share an account.
- **Task:** a name, its prerequisites, its result and the access profile it needs.

Installed names map onto these as follows:

- `devAccount` is the GitHub account in Hippy's identity.
- `mergeAccount` is the GitHub account in Lawd's identity.
- `models.*` and `runtime` are identity settings.
- `jobRoles` (`reader`, `writer`, `merger`) are access profiles.

Renaming the installed keys waits on ecosystem #166.

## bindings-and-ready-tasks

Delegated. This settles open question 3.

For a task that checks or changes a revision, the result's binding records:

- the repository and the work item;
- the task;
- the revision: its full code commit, its trusted-input revision and its policy digest;
- the target state: its branch and full commit.

A result is current only while every part still matches. An absent part never counts as a match.

A task's result records:

- its binding;
- its verdict, which is one of passed, failed, refused or unknown;
- its receipt;
- the buddy run that produced it.

**Ready tasks** are the tasks whose prerequisites are current and whose own result for the current binding is missing. Use this name, not status or stage.

A verdict belongs to the result. It is separate from the outcome of the run that produced it.

Each task keeps its own attempt budget per binding, as `runs-and-retries` says.

## requirements-bindings

Autumn approved on 2026-10-24.

Author and the first Implementation run before any revision exists, so their binding uses the requirements in place of a revision:

- the repository and the work item;
- the task;
- a digest of the requirements: the work item's body and any accepted spec comment;
- the target state: its branch and full commit.

```
{ repo, workItem: 187, task: "Author",
  requirements: "sha256:…",
  target: { branch: "main", commit: "c313420…" } }
```

Editing the requirements makes the result stale. A comment or label change that leaves them alone doesn't. A buddy can therefore tell by itself when the next task is ready: Implementation is ready when Author's result is current for the requirements digest and no Implementation result exists yet.

## no-repeated-checks

Autumn approved on 2026-10-24.

A passed result never reruns for the same binding. Any change to the binding creates a new ready task with a new attempt budget, as rule 5 of `runs-and-retries` already does for revisions.

## sequential-tasks

Autumn approved on 2026-10-24.

A task is ready only when all its prerequisites are current. Tasks run in one chain, with no parallel branches for now:

```
Author → Implementation → Hardening → Sync → Integration → Security → Land → Completion
```

## runs-and-retries

Autumn approved. This settles open question 4. Autumn asked for rules that lose no work and stay simple.

1. Every restart is a retry: a new run with a new run identity, linked to the run it follows. No run resumes under its old identity.
2. No run loses work. On every exit, including errors, stops and timeouts, a run keeps its uncommitted work and records a checkpoint before it ends. A retry starts from the latest kept checkpoint, never from a reset. Only a person discards work, and only on purpose.
3. After an uncertain action, a retry first reconciles by reading. If it can't establish the result, it stops and holds. It never repeats the action.
4. A run is in one of four states:
   - **running**;
   - **waiting:** a prerequisite or a hold is unmet;
   - **stopped:** it needs a person, and its work is kept;
   - **ended:** it has an outcome.
5. Each retry uses one attempt from its task's budget for the same binding. At the limit, the task stops for a person. A new binding, such as a new revision, target state or policy, starts a new budget.

## capacity-by-resource

Autumn approved. This settles open question 6.

The caller counts capacity by resource, not by role or task. Model sessions, test slots and writes to a target are examples of resources, and each resource has its own cap.

A slot or reservation is released only when every registered consumer reports that it's done. A run ending doesn't release one. When a consumer's state is unknown, the slot stays held.

## shared-reservations

Autumn approved on 2026-10-24. This sets the direction for capacity; it changes nothing installed yet.

Buddies are meant to find their own work, so the caller won't stay the one place that counts capacity. The target is shared reservation records. Each resource cap is a set of authenticated coordination records. A buddy run claims a slot before it starts, using the same fenced claim as work-item ownership, and releases it under the consumer rule above.

```
reservation {
  resource: "model-session",
  slot: 2 of 3,
  holder: <invocation binding>,
  consumers: [...]
}
```

The caller keeps counting until the assignment-sweep work starts. Until then, build claims (#167, #168 and #171) so they can later cover resources as well as work items.

## observation-sources

Autumn approved. This settles open question 7.

| Fact | Source |
| --- | --- |
| Liveness | A fresh process observation together with the run's lease record |
| Ownership | Authenticated coordination records |
| An action's result | A read of the system the action changed, such as GitHub or the Git remote |

When a read is partial, stale or conflicts with another, the fact is unknown. Unknown never counts as success, failure or absence. It leads to reconciliation by reading, and then to a hold if the fact stays unknown.

## fresh-reads

Autumn approved on 2026-10-24.

A run reads ownership and the results it depends on immediately before each privileged effect, such as starting a writer session, committing, pushing or landing. A cached reading never authorizes anything. Only liveness has a time bound, which is the lease's expiry.

A listing is complete only when every page was read and none failed. When a listing is cut short or a page errors, every fact drawn from it is unknown. It leads to a hold, never to "absent".

## assignment-permission

Autumn approved. This settles open question 8.

Only `axolotl-logic` grants or withdraws an assignment. An assignment lets the assigned buddy's runs perform their role's tasks for that work item, within the existing authorization rules. It grants nothing else.

Any other change pauses the work item and grants nothing. This covers an assignment by another account and a comment from someone who isn't trusted. While a work item is paused, no new run starts on it. A running run reaches a safe exit and records a checkpoint. A withdrawal by `axolotl-logic` pauses the work item the same way.

## lawd-lands-and-installs

Decided by Autumn on 2026-10-24.

Lawd authorizes source acceptance and Land, and then installs and activates the pipeline. Autumn chose no extra gate on installation: Lawd installs the revision it landed.

Lawd can't install yet. Until that capability exists, the operator installs, and landing changes nothing that runs until then.

## compatibility-later

This settles open question 5 by deferring renames. Ecosystem #166 plans the renames of persisted keys, config keys and CLI flags, with a compatibility plan first. Until then, these decisions rename no saved data, configuration or command line.

## additive-record-versions

Autumn approved on 2026-10-24. This narrows `compatibility-later`.

New fields may be added before #166, but only in a new record version:

- Readers accept every older version and never rewrite an old record.
- A missing part of an older record never counts as a match, so an old record can't grant authority.
- Renaming keys still waits for #166.

```
coordination record v2 = v1 + { task, revision, targetCommit }
reader: accepts v1 and v2; a v1 record's missing parts never match
```

This is how saved state and coordination records are already versioned.
