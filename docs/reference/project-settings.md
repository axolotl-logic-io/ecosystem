# Project settings

The pipeline reads reproducible project settings only from the repository's tracked `.issue-pipeline.json`. The operator selects the trusted commit explicitly, and every repository config must pin one. A candidate's working-tree edits, branch movement or changed settings file never activate policy for that candidate. This is configuration pinning, not a sandbox: configured commands still execute candidate code, including scripts those commands call.

## Field ownership

| Source | Fields |
|---|---|
| Committed project document | `commands.setup`, `commands.test`, `commands.lint`, `commands.typecheck`, `commands.teardown`, `commands.prune`; `practices`; `lockfiles`; `migrations`; `resources.modelSessions` |
| Operator config | Credentials and account identities; `allowedUsers`; `repo`, `cloneUrl`, `baseBranch`, Git identity and paths; `models`, `runtime`, [legacy `jobRoles` access settings](sessions.md#compatibility) and network declarations (not enforced isolation); CI requirements and command timeouts |

The project document accepts only those project fields. Unknown fields, duplicate JSON members and unknown nested keys are errors, not ignored settings. It cannot supply a token, credential path, model registration, allow-list, account, alternate destination or authorization bypass. The operator config must omit **all five** project fields (`commands`, `practices`, `lockfiles`, `migrations`, `resources`), including optional ones the document omits. There is no competing override layer.

`resources.modelSessions` remains accepted for compatibility with pinned project documents. Task apps do not reserve model-session capacity or enforce this value.

`commands.test` is required and nonblank. Optional commands may be omitted or null; a supplied string must be nonblank. `practices` and lockfile paths must stay inside the checkout. Each lockfile entry has `path` and `regenerate`. A non-null `migrations` object needs nonempty `pathGlobs` and an `up` command; `setup` and `down` are optional. Task apps do not run `commands.prune` or `commands.teardown`; writer apps refuse a nonempty teardown.

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
  "practices": ["AGENTS.md", "docs/project-practices.md"],
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

The loaded config snapshots the effective checking settings and computes a policy digest for standalone reports. Task apps recover from GitHub; they do not write exact-binding authorization records. A different committed pin affects future runs, even when the document bytes match. No credential value enters the digest or snapshot.

## Provision committed settings

1. Commit and review `.issue-pipeline.json` in the configured repository under the policy already trusted for that change.
2. Obtain the reviewed commit in an operator-owned local clone of that same repository. Keep its commit and objects available for the lifetime of actions using it.
3. Preserve the current operator config and recovery evidence, then drain active runs before changing the policy source, pin or capacity.
4. Starting from `apps/issue-host/repos/example.json`, set the real repository/account/runtime controls and the reviewed source path and full commit. The all-zero example pin is a placeholder, not runnable policy.
5. Remove `commands`, `practices`, `lockfiles`, `migrations` and `resources` from that operator config. Keep credentials and every operator control outside the project document.
6. Validate the explicitly scoped buddy configuration before starting work. Retained unfinished work needs current prerequisite evidence and an authorized trigger. Review the current head before landing.

Installation copies the nonsecret operator example but never creates a policy clone, selects a trusted commit, rewrites an operator config or activates repository settings automatically. Changing the tracked document needs ordinary review first, followed by an explicit operator pin update for future actions.

## Retired keys and recovery

Repository configuration keys the pipeline no longer reads, such as `assignments`, `takeNewWork`, `maxJobs` or the old retry counters, are ignored without a warning. They cannot grant work, limit current tasks or continue a spent cause. Keys that #166 renamed are read only under their new names.

Task apps do not adopt saved state or rewrite historical receipts. Preserve retained work and read the current PR before retrying.
