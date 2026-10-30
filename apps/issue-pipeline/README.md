# Issue pipeline

A buddy is a launcher of task apps. It polls its configured repositories for `start:TASK` labels and runs the matching app. The framework claims the start, marks the issue, runs the task and unmarks it. Only version 2 buddy files are supported.

Landing changes nothing that runs until the operator installs the release. See [operations](../../docs/reference/operations.md), [runtime runs](../../docs/reference/runtime-runs.md) and the [reference index](../../docs/README.md).

## Configure a buddy

A launcher buddy file is private operator-owned JSON, version 2. It names the buddy's scope (the repository configs it covers), its tasks, its single GitHub account and the entry of the operator's private credential file that holds that account's token:

```json
{
  "version": 2,
  "name": "hippy",
  "scope": { "repositories": ["/absolute/path/to/repository-config.json"] },
  "tasks": ["gherkin", "implement", "fix"],
  "account": {
    "login": "DEVELOPER_ACCOUNT",
    "credentials": {
      "file": "/absolute/path/to/credentials.env",
      "variable": "HIPPY_GITHUB_TOKEN"
    }
  }
}
```

The buddy makes every GitHub write through its own account, and so do the task apps it launches. Each buddy needs its own account: keep a machine's buddy files in one folder, and a buddy refuses to start when another buddy file there names its account. The repository config's `devAccount` and `landingAccount` pairing plays no part in a launcher buddy.

To validate a buddy file without starting the buddy:

```bash
node "$ISSUE_PIPELINE_ROOT/buddy.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to the buddy file. Omit `--check` to start the buddy. The [runtime reference](../../docs/reference/runtime-runs.md#launcher-buddies) defines the exact keys, the trust checks, how the buddy launches each app and what it logs. Each task in `tasks` needs its installed task app, `$ISSUE_PIPELINE_ROOT/TASK.mjs`; the buddy refuses to start without it.

## Tasks

| Task | Program | Work |
| --- | --- | --- |
| Gherkin | `gherkin.mjs` | Write or update Gherkin, or ask the author questions |
| Implement | `implement.mjs` | Continue pushed work, open a draft PR, write and harden, then mark ready |
| Verify | `verify.mjs` | Run full checks, required CI and Security review on the current PR head |
| Fix | `fix.mjs` | Merge the base and answer unresolved blocking review comments |
| Land | `land.mjs` | Read prerequisites from GitHub, merge the pinned head and close the issue |

Each app uses `node TASK.mjs --config BUDDY_FILE --issue OWNER/REPO#N`. Manual invocation refuses unless the buddy's `tasks` includes that app, before claiming or writing. Only its start label starts it. Running labels show activity and never gate starts. Reviews, earlier results and assignments do not start tasks. Retries continue from GitHub comments, pushed commits, PRs and reviews. There is no saved state, task ledger, signal inbox, reservation pool or coordination journal.

`agents:stop` holds claims while present and ends runs at framework boundaries and before writes. Removing it permits pending starts; nothing is latched. See [stops and labels](../../docs/reference/stops-and-labels.md).

## The Gherkin task app

Gherkin writes an issue's behaviour as Gherkin, or asks the questions that only the issue's author can answer. It's a [task app](../../docs/reference/runtime-runs.md#task-app-runs), so only `start:gherkin` starts it, and the framework claims the start, marks the run with `agent:gherkin:running` and posts its end comment. A launcher buddy whose `tasks` lists `gherkin` runs it for each `start:gherkin` it sees. To run it by hand, run:

```bash
node "$ISSUE_PIPELINE_ROOT/gherkin.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
```

- `BUDDY_FILE` is the absolute path of a launcher buddy file. Gherkin acts as its account.
- `OWNER/REPO#N` is the issue.

Its work is one read-only session as the `issue-pipeline-gherkin` agent, on the `gherkin.md` prompt page and the repository config's `models.gherkin`. The session reads an issue file of trusted people's words and a detached checkout of the base branch, holds no GitHub token and returns its reply through structured output. See [the Gherkin session](../../docs/reference/sessions.md#gherkin-session).

The app posts the reply. Gherkin goes in the issue's one Gherkin comment: a later run finds that comment by its hidden marker and edits it, rather than posting a second one. Questions go in a new comment every time. Either way, the issue's author answers on the issue and a person applies `start:gherkin` again.

Gherkin reads the whole repository config, not just its `repo` and `baseBranch`: the session needs its `models.gherkin`, `allowedUsers`, `runtime` and `cloneUrl`. It fetches the base branch into the pipeline's mirror with the config's `devAccount` credential, as the buddy runtime does. Every GitHub write is still the buddy's own account's.


## Standalone tools and shared utilities

Safe Refactor and standards upgrade retain their standalone entrypoints. The task apps share credential-free model sessions, bounded Git review, guarded commits and private checkouts. These tools preserve local work when a run fails. A local mirror mutex only serializes Git metadata updates; it grants no work ownership.

The [Git review tools](../../docs/reference/runtime.md) and [sessions](../../docs/reference/sessions.md) describe their boundaries. This is not an OS sandbox: same-user files can still be readable.

Repository configs retain compatibility credentials for shared readers and standalone tooling. Task app writes use the buddy's own account. Verify must use an account different from the PR author's. `laneSlots` is refused; writers also refuse `commands.teardown`, which task apps do not run.

## Config and model cutover

Operator config lives in `$ISSUE_PIPELINE_ROOT/repos/`, starting from `repos/example.json`. Every config pins the repository's committed `.issue-pipeline.json` with `projectPolicy`; there is no flat-config mode. `src/config-schema.ts` defines operator shape/defaults. [Project settings](../../docs/reference/project-settings.md) describes the strict tracked `.issue-pipeline.json`, operator-owned identity/safety controls, the trusted full-commit pin and the policy binding. Candidate settings edits never activate policy for the same candidate. Task apps load the pinned project settings. Config keys the pipeline no longer reads are ignored without a warning, and keys renamed in #166 are read only under their new names.

Existing operator keys and installed interfaces remain compatible; see [session compatibility](../../docs/reference/sessions.md#compatibility). No private config or live record migration is required.

The default and example session models are `openai/gpt-6.1-sol`. Set all three session models explicitly rather than relying on retired model aliases:

```json
{
  "models": {
    "gherkin": "openai/gpt-6.1-sol",
    "developer": "openai/gpt-6.1-sol",
    "reviewer": "openai/gpt-6.1-sol"
  }
}
```

All model sessions now require the explicit, separately provisioned [native runtime policy](runtime/README.md): trusted **Pi 1.2.0 + pi-cliproxyapi 0.4.3**, a dedicated model-child HOME, explicit provider extension/profile/cache, declared model credential **names** and reviewed native context-window expectations. The supported starting profile is builtin OpenAI through a distinct proxy endpoint. Set `runtime.modelContextWindows` explicitly; there is no inferred expectation. See `repos/example.json` and the nonsecret `runtime/pi-cliproxyapi-config.example.json`. Model strings pass unchanged to `--model`; unsupported registrations refuse rather than falling back.

Native automatic compaction targets **175000** tokens with **30000** recent-history tokens. For the expected 272000-token window, reserve is **97000**. This is same-session native context management, not a token/spending cap. Private generated agent settings, disabled project/personal resource discovery and correlated pre-prompt native verification enforce policy for every session. Only explicit provider/session/pipeline resources load; inherited extensions are no longer used. This is configuration isolation, **not** an OS/filesystem/keyring/network sandbox. Credentialed operations keep their own HOME. Global/personal provider setup is neither copied nor changed. Tests use fake models and local origins only.

## Programs and observations

`programs.ts` is the shared build, install and syntax-check manifest. `ops.mjs`, `database.mjs` and `recover-implement.mjs` are retired. New task runs write `runs/SLUG/issue-N/task-runs/UUID/run.json`; a losing claimant writes nothing. The launcher logs app exits and failed listings to stderr and writes no buddy-run record.

The dashboard keeps reading historical buddy/action files and current task runs. Its monitoring tables remain unchanged and independent of coordination storage. The pipeline has no shared-database dependency.

## Install and safe upgrades

Before landing, run the full gate under Node 24:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check:full
```

The operator must drain old buddies, preserve retained work, install and restart with version 2 buddy files. Do not run old and new releases together on one repository.

```sh
mise //apps/issue-pipeline:install:dry-run
mise //apps/issue-pipeline:install
```

The installer backs up replaced files and writes `INSTALLED.json`. It does not rewrite private configs or remove files outside its manifest. Retire obsolete installed entrypoints manually after draining. Delete old status labels only once no installed release writes them; see [upgrade labels](../../docs/reference/stops-and-labels.md#upgrade-labels). No database migration is needed.

## Tests

```sh
npm run check
npm run check:full
```

The fast gate typechecks, lints, builds and checks program syntax. The full gate also runs all non-external pipeline tests, with file concurrency 8 and per-test timeout 180000 ms, then the dashboard gate. Tests use fake GitHub and models, real local Git and temporary pipeline roots. See [writing tests](test/README.md) and [gate scope](../../docs/reference/check-gates.md). mise is optional and calls the same scripts.
