# Project settings

The pipeline can read reproducible project settings from the repository's tracked `.issue-pipeline.json`. The operator selects the trusted commit explicitly. A candidate's working-tree edits, branch movement or changed settings file never activate policy for that candidate. This is configuration pinning, not a sandbox: configured commands still execute candidate code, including scripts those commands call.

## Field ownership

| Source | Fields |
|---|---|
| Committed project document | `commands.setup`, `commands.test`, `commands.lint`, `commands.typecheck`, `commands.teardown`, `commands.prune`; `practices`; `lockfiles`; `migrations` |
| Operator config | Credentials and account identities; `allowedUsers`; `repo`, `cloneUrl`, `baseBranch`, Git identity and paths; `models`, `runtime`, `jobRoles` and network access; CI requirements; timeouts, retries, lease and merge controls; caller limits, stage caps and lane pool size |

The project document accepts only those project fields. Unknown fields, duplicate JSON members and unknown nested keys are errors, not ignored settings. It cannot supply a token, credential path, model registration, allow-list, account, alternate destination, caller cap or authorization bypass. In committed mode the operator config must omit **all four** project fields (`commands`, `practices`, `lockfiles`, `migrations`), including optional ones the document omits. There is no competing override layer.

`commands.test` is required and nonblank. Optional commands may be omitted or null; a supplied string must be nonblank. `practices` and lockfile paths must stay inside the checkout. Each lockfile entry has `path` and `regenerate`. A non-null `migrations` object needs nonempty `pathGlobs` and an `up` command; `setup` and `down` are optional. `commands.prune` is reserved for the lane-resource consumer; accepting it does not itself allocate or prune resources.

This repository's root `.issue-pipeline.json` supplies its pipeline gate and practice files. A small project document looks like:

```json
{
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

That path is operator-owned, not a job checkout setting. The source's `origin` must equal the configured repository's HTTPS origin, or the explicit local origin used by a synthetic test. A different GitHub repository or alternate remote is refused. The loader reads Git objects only, with replacement objects and lazy fetching disabled. It does not check out a branch, fetch, run source hooks or read the mutable settings file. A tag, abbreviated SHA, missing commit, absent settings file, symlink, nonregular file, malformed document or unknown key stops loading; there is no worktree or flat-config fallback.

The loaded config snapshots the effective checking settings. `job.json` records `policyBinding`: its mode, effective settings and digest, plus the source commit, blob and SHA-256 of the document in committed mode. The digest includes the committed source/pin and effective project/checking controls, including the operator's CI requirement and command timeout. Object-key order and JSON whitespace in legacy config do not change policy; a different committed pin does, even when its document bytes match. No credential value enters the digest or snapshot.

Every newly computed authorization revision records that digest as `policy`, alongside code and trusted inputs. A changed source, pin or effective checking policy invalidates old hardening, integration and Security authorization. Each ops child computes its own binding and refuses a different policy from the job's snapshot before posting queued comments or running its operation. A caller-supplied digest is only an expected-value comparison; it never replaces the computed policy.

## Provision committed settings

1. Commit and review `.issue-pipeline.json` in the configured repository under the policy already trusted for that change.
2. Obtain the reviewed commit in an operator-owned local clone of that same repository. Keep its commit and objects available for the lifetime of jobs using it.
3. Preserve the current operator config and recovery evidence, then drain active jobs before changing the policy source or pin.
4. Starting from `apps/issue-pipeline/repos/committed-settings.example.json`, set the real repository/account/runtime controls and the reviewed source path and full commit. The all-zero example pin is a placeholder, not runnable policy.
5. Remove `commands`, `practices`, `lockfiles` and `migrations` from that operator config. Keep credentials and every operator control outside the project document.
6. Run an explicitly assigned boundary check, then restart appropriate checks/review for retained unfinished work. A saved old approval does not authorize the new policy.

Installation copies the nonsecret operator example but never creates a policy clone, selects a trusted commit, rewrites an operator config or activates repository settings automatically. Changing the tracked document needs ordinary review first, followed by an explicit operator pin update for future jobs.

## Legacy configuration and recovery

Without `projectPolicy`, the existing flat operator config remains supported as legacy mode. It reads no candidate policy file. Newly computed revisions still bind its effective checking policy, so changing its commands or CI requirement between stages cannot reuse earlier approval. Existing model-role migration and removed-field warnings remain unchanged.

Saved revisions without `policy` remain readable, including PR/head, merge attempts, successful merge receipts, Security findings and local recovery files. Missing historical policy is unknown, not a digest the loader can reconstruct. An unmerged old hardening receipt requires fresh review/checks before another merge. The pipeline never rewrites historical receipts to make them match the current policy. Already-merged truth and genuine completion evidence stay historical; a new policy does not authorize another code mutation or erase a rejection. Uncertain or incompatible recovery needs explicit reconciliation with the retained evidence, not deletion or automatic adoption of candidate-owned settings.

For a canonically confirmed own merge, the pipeline can recheck the unchanged result and run read-only Security under the current policy. This creates a new result observation in the Security receipt, not a policy value for the old authorization or merge receipt. Completion validates that original history independently and requires exact current-policy clearance. Policy drift alone never clears a known finding on unchanged code and trusted inputs. This recovery grants no writer, push or second merge.
