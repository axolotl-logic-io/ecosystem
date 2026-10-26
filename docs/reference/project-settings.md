# Project settings

The pipeline reads reproducible project settings only from the repository's tracked `.issue-pipeline.json`. The operator selects the trusted commit explicitly, and every repository config must pin one. A candidate's working-tree edits, branch movement or changed settings file never activate policy for that candidate. This is configuration pinning, not a sandbox: configured commands still execute candidate code, including scripts those commands call.

## Field ownership

| Source | Fields |
|---|---|
| Committed project document | `commands.setup`, `commands.test`, `commands.lint`, `commands.typecheck`, `commands.teardown`, `commands.prune`; `practices`; `lockfiles`; `migrations`; `resources.modelSessions` |
| Operator config | Credentials and account identities; `allowedUsers`; `repo`, `cloneUrl`, `baseBranch`, Git identity and paths; `models`, `runtime`, `jobRoles` and network declarations (not enforced isolation); CI requirements; command and confirmation timeouts; explicit repository Land permission; test-environment pool size |

The project document accepts only those project fields. Unknown fields, duplicate JSON members and unknown nested keys are errors, not ignored settings. It cannot supply a token, credential path, model registration, allow-list, account, alternate destination or authorization bypass. The operator config must omit **all five** project fields (`commands`, `practices`, `lockfiles`, `migrations`, `resources`), including optional ones the document omits. There is no competing override layer.

`resources.modelSessions` is a required positive integer: the shared model-session capacity for this repository and target branch. Buddy declarations must match this pool policy. Conflicting live declarations hold; changing the cap requires draining the pool. There is no inferred capacity from process or action counts.

`commands.test` is required and nonblank. Optional commands may be omitted or null; a supplied string must be nonblank. `practices` and lockfile paths must stay inside the checkout. Each lockfile entry has `path` and `regenerate`. A non-null `migrations` object needs nonempty `pathGlobs` and an `up` command; `setup` and `down` are optional. `commands.prune` is reserved for the lane-resource consumer; accepting it does not itself allocate or prune resources.

This repository's root `.issue-pipeline.json` supplies its pipeline gate and practice files. A small project document looks like:

```json
{
  "resources": { "modelSessions": 1 },
  "commands": {
    "setup": "npm ci",
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck"
  },
  "practices": ["AGENTS.md", "docs/coding-practices.md"],
  "lockfiles": [],
  "migrations": null
}
```

## Trusted revision and binding

The operator's `projectPolicy` setting selects an absolute local repository path and a full 40-character commit SHA:

```json
{
  "projectPolicy": {
    "repository": "/absolute/trusted/checkout",
    "revision": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

That path is operator-owned, not a job checkout setting. The source's `origin` must equal the configured repository's HTTPS origin, or the explicit local origin used by a synthetic test. A different GitHub repository or alternate remote is refused. The loader reads Git objects only, with replacement objects and lazy fetching disabled. It does not check out a branch, fetch, run source hooks or read the mutable settings file. A missing `projectPolicy`, a tag, abbreviated SHA, missing commit, absent settings file, symlink, nonregular file, malformed document or unknown key stops loading; there is no worktree or flat-config fallback.

The loaded config snapshots the effective checking settings. Canonical action observations record the binding used by their task. The shared policy digest includes the committed source/pin and effective project/checking controls, including the operator's CI requirement, command timeout, repository Land permission and shared resource capacity. Buddy-specific scope, identity and permission form a separate action-authorization digest; they never make Developer and Gatekeeper use different checking policies. Object-key order and JSON whitespace do not change policy; a different committed pin does, even when its document bytes match. No credential value enters the digest or snapshot.

Every newly computed authorization revision records that digest as `policy`, alongside code and trusted inputs. A changed source, pin or effective checking policy invalidates old hardening, integration and Security authorization. Each ops child computes its own binding and refuses a different policy from the action's configuration snapshot before posting queued comments or running its operation. A caller-supplied digest is only an expected-value comparison; it never replaces the computed policy.

## Provision committed settings

1. Commit and review `.issue-pipeline.json` in the configured repository under the policy already trusted for that change.
2. Obtain the reviewed commit in an operator-owned local clone of that same repository. Keep its commit and objects available for the lifetime of actions using it.
3. Preserve the current operator config and recovery evidence, then drain active consumers before changing the policy source, pin or capacity.
4. Starting from `apps/issue-pipeline/repos/example.json`, set the real repository/account/runtime controls and the reviewed source path and full commit. The all-zero example pin is a placeholder, not runnable policy.
5. Remove `commands`, `practices`, `lockfiles`, `migrations` and `resources` from that operator config. Keep credentials and every operator control outside the project document.
6. Validate the explicitly scoped buddy configuration before starting work. Retained unfinished work needs current prerequisite evidence and an authorized trigger. A saved old approval does not authorize the new policy.

Installation copies the nonsecret operator example but never creates a policy clone, selects a trusted commit, rewrites an operator config or activates repository settings automatically. Changing the tracked document needs ordinary review first, followed by an explicit operator pin update for future actions.

## Retired keys and recovery

Repository configuration keys the pipeline no longer reads, such as `assignments`, `takeNewWork`, `maxJobs` or the old retry counters, are ignored without a warning. They cannot grant work, limit current tasks or continue a spent cause. Keys that #166 renamed are read only under their new names.

A new policy never rewrites earlier receipts or erases a rejection. Uncertain or incompatible recovery needs explicit reconciliation with the retained evidence, not deletion or automatic adoption of candidate-owned settings.

Complete binds to the authenticated own Land's original revision, pre-Land target and policy. Policy drift after that irreversible mutation does not request new Hardening, Integration or Security. Complete checks the original exact prerequisite records, own Land receipt, unchanged trusted inputs and current target ancestry. Contradictory or incomplete evidence holds. A changed policy never clears a known Security refusal or grants a writer, push or second Land.
