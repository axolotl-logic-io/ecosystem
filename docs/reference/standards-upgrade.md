# Standards upgrade

The standards upgrade brings one GitHub repository up to an evidence-backed maintenance standard ([#129](https://github.com/axolotl-logic-io/ecosystem/issues/129)). It has two halves. A deterministic assessment reads the repository and writes a plan. Then the existing issue-delivery chain carries that plan to a draft pull request, the same way it carries any issue.

```text
standards-upgrade assess --config CONFIG --repo OWNER/REPO [--ref REF] --out DIR
   → assessment.json, report.md, plan.md, logs/ (no remote writes)
an allow-listed collaborator files plan.md as the repository's one upgrade issue
standards-upgrade apply --config CONFIG --issue ISSUE
   → issue branch, plan metadata and human-start handoff (read-only checks)
a person applies start:implement; the task app claims the start
```

`CONFIG` is the repository operator config, `OWNER/REPO` is the assessed repository, `REF` is an optional source ref, `DIR` is the output directory and `ISSUE` is the filed issue number. The plan and assessment grant no execution or Land authority.

This page describes the assessment and the admission of its plan. Landing them installs and activates nothing. Nothing schedules it, and it never runs across many repositories by itself.

## Scope of this slice

The assessment supports two ecosystems: Node/npm and Python/Poetry. Every other ecosystem, including Python without Poetry (`requirements.txt`, `setup.py` or another build backend), Go and native builds, gets the disposition `unsupported` and the verdict `blocked`. The assessment names the toolchains it saw instead of guessing at an upgrade.

Poetry support follows the repositories that use it. On 2026-10-24, `axolotl-logic-io` had no Poetry repositories. Its migration source `axolotl-logic` had six with a root Poetry manifest: `lambda-calculus`, `aoc2021`, `ratato-bot` and `five-finder`, plus the archived `scompete` and `moody`. All four active ones came from `poetry new`: `[tool.poetry]`, `python = "^3.9"`, pytest as a dev dependency, and no CI.

For Node/npm, the assessment installs the repository, runs its tests and scans its advisories in a credential-free sandbox, described below. So a Node/npm repository can be rated `acceptable` when every criterion passes.

Python/Poetry gets the same three checks in the same sandbox, and nothing is installed on the host. The host's own Python, 3.10 or newer with `venv` and `ensurepip`, makes a throwaway virtualenv inside the sandbox. pip fills it with hash-pinned `poetry` and `pip-audit` from PyPI. So a Poetry repository can be rated `acceptable` too.

## The sandbox

Each command runs in its own [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) container. `bwrap` must be installed on the host, and unprivileged user namespaces must be allowed. Without it, the three criteria are `unverified` and say why.

The container holds no credential. Here's what it sees:

| Inside | What it is |
|---|---|
| `/usr` (read-only) | System software, with `/usr/local` hidden. |
| A few `/etc` files (read-only) | `resolv.conf`, `hosts`, `nsswitch.conf`, `ssl`, `ca-certificates`, for name resolution and TLS. |
| `/opt/node` (read-only) | The running Node binary and npm's package. Not their prefix, so no global `npmrc`. |
| The host Python's prefix (read-only, Poetry only) | At its own path, since a shared `libpython` is linked by it. Its `etc/` and `site-packages` are hidden, so none of the host's packages are visible. |
| `/tools` and `/opt/standards/python-tools.txt` (Poetry only) | The throwaway tools virtualenv, and the pinned requirements it's installed from. |
| `/work` | A fresh export of the source commit, without `.git`. |
| `/cache` | npm's package cache for this assessment. |
| `/home`, `/tmp` | Empty, private, size-limited. |
| `/proc` | Its own PID namespace: no other process's environment. |

Nothing else of the host exists inside. The environment is empty, apart from `HOME`, `PATH`, `CI` and npm's settings. `bwrap` itself starts through `env -i`, because its own processes stay visible at `/proc/1/environ` inside. The work, cache and every container are deleted afterwards.

For Node/npm, the commands run in this order:

```
network, npm's own code only:   npm ci --ignore-scripts --no-audit
                                npm audit --json
no network, repository code:    npm rebuild --foreground-scripts   (dependency install scripts)
                                npm test
```

Repository code never runs with the network. The two fetching commands go only to the registry the operator chose with `--npm-registry`, set through the environment, so a repository's `.npmrc` can't redirect it. If the lockfile fetches any package from elsewhere, such as a git or tarball URL, nothing runs and the criteria say so. Without a `package-lock.json` or `npm-shrinkwrap.json`, nothing runs either.

For Python/Poetry, the commands run in this order:

```
no network:                       python3 -m venv /tools/venv          (the host's Python)
network, pip's own code only:     pip install --require-hashes --only-binary=:all: --no-deps -r python-tools.txt
no network:                       poetry check --lock
network, tool code only:          poetry install --no-root             (dependencies, wheels only, into /work/.venv)
                                  pip-audit --format json              (over /work/.venv)
no network, repository code:      poetry install --only-root
                                  poetry run python -m pytest
```

The tools come from [`python-tools.txt`](../../apps/issue-host/src/standards/python-tools.txt): `poetry` 2.5.1 and `pip-audit` 2.10.1 with all their dependencies, each pinned to its wheels' hashes. pip refuses any wheel that doesn't match, and any source distribution, so no build code runs. It was made with `uv pip compile --generate-hashes --universal --python-version 3.10 --only-binary :all: --exclude-newer DATE`, with `DATE` at least two weeks before the pin.

Poetry installs dependencies as wheels only (`POETRY_INSTALLER_ONLY_BINARY=:all:`), so no dependency's build script runs either. The project itself installs afterwards, with no network. pip reads no configuration files, and Poetry's keyring is off.

Nothing runs without a `poetry.lock`. Nothing runs when `pyproject.toml` declares its own package sources, or `poetry.lock` fetches a package from a git, URL or custom source: only PyPI is fetched from.

### Test runs

The tests run three times, each with no network:

1. **Twice as they are.** Different exit codes mean the suite is flaky, which is `failed`. Two non-zero exits are `failed`.
2. **Once more with a deliberately failing test added.** The test must now fail. If it still exits 0, the runner hides failures or doesn't run new test files, and that's `failed` too.

The added test goes in the first of `test/`, `tests/` or `__tests__/` the repository has, else the root, as `standards-mismatch.test.js`. It uses the global `test` or `it` (Jest, Vitest with globals, Mocha), else `node:test`. For Poetry it goes in `tests/`, `test/` or the root, as `test_standards_mismatch.py`.

A command inside the sandbox writes that test, never the assessment itself. By then repository code has had write access to `/work`, and a symlink it planted there would turn a write from the host into a write outside the sandbox. A test proves it: a symlink planted at the added test's path doesn't reach the host file it points to.

What the commands print goes to `OUT_DIR/logs/`, never into `assessment.json`, `report.md` or `plan.md`. Repository code wrote it, and the plan gets filed publicly. The criteria hold only exit codes and audit counts. Each command has a 10-minute limit.

## Run an assessment

To assess the configured repository at its default branch, run from the repository root:

```bash
npm run build --workspace @ecosystem/issue-host
node "$ECOSYSTEM_INSTALL_ROOT/standards-upgrade.mjs" assess \
  --config CONFIG --repo OWNER/REPO --out OUT_DIR
```

- `CONFIG` is the target repository's pipeline config, as `docs/reference/operations.md` describes. The assessment reads GitHub with its `landingAccount` credential, for reads only.
- `OWNER/REPO` names the repository, either as a slug or as its canonical URL, such as `https://github.com/OWNER/REPO`. It must be the config's `repo`.
- `OUT_DIR` is an existing, empty folder outside any checkout.

_Optional:_
- Add `--ref REF` to assess a branch, tag, full ref or full commit instead of the default branch.
- Add `--npm-registry URL` to fetch from another npm registry, such as a mirror. The default is `https://registry.npmjs.org/`.
- Add `--pypi-index URL` to install the pinned Python tools from another index, such as a mirror. The default is `https://pypi.org/simple/`. Poetry still fetches the project's dependencies from PyPI.
- Add `--python-tools FILE` to install other hash-pinned tools. Every line needs its hashes.
- Add `--static` to run nothing. Install, tests and the scan are then `unverified`.

The command prints one JSON line:

```json
{"verdict":"not-acceptable","disposition":"node-npm","source":"3f1c…","assessment":"OUT_DIR/assessment.json","report":"OUT_DIR/report.md","plan":"OUT_DIR/plan.md"}
```

`OUT_DIR/logs/` holds one log per sandboxed command, such as `1-npm-ci.log`. Read them as untrusted text.

Exit 0 means the assessment finished, whatever its verdict. Exit 2 means a refusal, with the reason on stderr and nothing written to `OUT_DIR`. Exit 1 means any other error.

## Refusals

The assessment refuses before it writes anything when:

- `--repo` isn't the config's repository. It refuses this before any GitHub or Git read.
- GitHub doesn't show the repository readable, or names it differently, as after a rename.
- `--ref` isn't one literal ref, or names no commit.

## What the assessment reads

It reads three things, all without writing:

- **The repository on GitHub:** its canonical name, whether it's archived, and its default branch.
- **The source:** a fetch of every branch and tag into a throwaway bare repository. A bare repository has no work tree, so no hook, `prepare` script or other repository code runs. It resolves the ref to one full commit before it looks at anything else.
- **Enforcement:** the default branch's required status checks, from branch protection and from the rulesets that apply to it.

## Dispositions

| Disposition | When | Verdict | What happens |
|---|---|---|---|
| `archived` | GitHub shows the repository archived | `no-action` | Nothing. No automatic writes and no unarchive. |
| `scaffold` | Every branch and tag holds only license, readme or ignore files | `archive-candidate` | An owner action recommends archiving, which needs explicit operator authority. No plan. |
| `node-npm` | The source commit has a root `package.json` | from the criteria | Criteria below, and a plan when anything needs changing. |
| `python-poetry` | No root `package.json`, and the root `pyproject.toml` has a `[tool.poetry]` table or builds with `poetry-core` | from the criteria | Criteria below, and a plan when anything needs changing. |
| `unsupported` | Anything else | `blocked` | The toolchains it saw are named. No plan. |

A scaffold check looks at every branch and tag, not just the default branch. A repository with code on any branch isn't a scaffold.

A repository with both a root `package.json` and a Poetry project is assessed as `node-npm`, and its Python side isn't checked. The disposition's toolchains still list `python`.

## Criteria

Each criterion has one status: `passed` (verified pass), `failed` (evidenced failure), `unverified` or `not-applicable`.

The criteria have the same names for both ecosystems. What passes depends on the ecosystem.

| Criterion | Node/npm passes when | Python/Poetry passes when |
|---|---|---|
| `environment.manifest` | The root `package.json` parses as a package manifest. | The root `pyproject.toml` parses as TOML. |
| `environment.toolchain` | `engines.node`, `.nvmrc` or `.node-version` declares the supported Node. | `tool.poetry.dependencies.python`, `project.requires-python` or `.python-version` declares the supported Python. |
| `environment.lockfile` | `package-lock.json` or `npm-shrinkwrap.json` is committed. A publishable library may omit one (`not-applicable`). A yarn, pnpm or bun lockfile is `unverified`. | `poetry.lock` is committed. A project that declares publishing metadata (classifiers, `repository` or `project.urls`) and isn't `package-mode = false` may omit one (`not-applicable`). |
| `environment.install` | `npm ci --ignore-scripts` and then `npm rebuild` exit 0 in the sandbox. Either failing is `failed`. No lockfile, a fetch outside the registry, no sandbox, or `--static` is `unverified`. | `poetry check --lock`, `poetry install --no-root` (wheels only) and then `poetry install --only-root` exit 0. Any of them failing is `failed`. No `poetry.lock`, a non-PyPI source, no sandbox, no usable host Python, tools that can't be set up, or `--static` is `unverified`. |
| `vulnerabilities.scan` | `npm audit` over the whole tree, dev dependencies included, reports no advisories. Any advisory is `failed`, with counts by severity. No report is `unverified`, never a clean scan. | `pip-audit` over the installed environment, dev groups included, reports no advisories. Any advisory is `failed`, with each package and advisory ID. No report is `unverified`. |
| `behavior.tests` | A real `test` script exists. A missing one, or npm's placeholder, means zero tests. | A `test_*.py` or `*_test.py` file defines a `test…` function. `poetry new`'s placeholder, `test_version`, which only asserts `__version__`, doesn't count, so a project with only that has zero tests. |
| `behavior.tests-run` | `npm test` exits 0 twice in the sandbox, with no network, and then fails with a deliberately failing test added. See [Test runs](#test-runs). | The same, with `poetry run python -m pytest`. |
| `ci.triggers` | A workflow runs on `pull_request`, and one runs on `push` to the default branch. | Same. |
| `ci.runs-tests` | A workflow step runs `npm test`, or `npm run test`, `check` or `ci`. | A workflow step runs `pytest`, `poetry run pytest`, or `python -m pytest` or `unittest`. |
| `ci.failure-propagation` | No `continue-on-error`, and no `\|\| true` or `--if-present` on a test command. | Same. |
| `ci.advisory-refresh` | Dependabot is configured, or a workflow runs on a schedule. | Same. |
| `ci.workspaces` | With workspaces, CI or the root test script runs `--workspaces`. One component is `not-applicable`. | One project is `not-applicable`. A nested `pyproject.toml` makes it `unverified`, since nested projects aren't assessed. |
| `ci.workflow-syntax` | Present only when a workflow file doesn't parse; then `failed`. | Same. |
| `enforcement.required-checks` | Branch protection or a ruleset requires a check. A read GitHub refuses makes it `unverified`, never `failed` or `passed`. | Same. |

For example, the inventory's `aoc2021` would show `environment.lockfile` and `behavior.tests` failed (no `poetry.lock`, only the placeholder test), `environment.toolchain` passed (`^3.9`), and every CI criterion failed except failure propagation.

The verdict follows from the statuses. Any `failed` gives `not-acceptable`. Otherwise any `unverified` gives `unverified`. Only all `passed` or `not-applicable` gives `acceptable`.

A green workflow never stands in for enforcement. Without a required check, the verdict can't be `acceptable`.

## Results

`assessment.json` follows the `ASSESSMENT` schema in [`src/standards/schema.ts`](../../apps/issue-host/src/standards/schema.ts). The entrypoint validates it before writing. It records:

- the repository, the requested ref, the resolved ref and the full source commit;
- the record version (2), the assessment time, the policy version (`standards-v2`) and the Node and Git versions;
- the disposition, the components, the workflows and the required checks;
- each criterion's status and evidence, and the verdict;
- the proposed changes, each tied to a criterion;
- the owner actions, which need separate authority, such as requiring a check or archiving;
- the sandbox: `bwrap`'s version or why there's none, the registry and npm's version;
- each command it ran: its arguments, whether it had the network, its exit code, its duration and its log's path.

`report.md` shows the same data for people.

`plan.md` exists only for a `node-npm` or `python-poetry` assessment with something to change. Its rules name the ecosystem's own checks: `npm ci`, `npm test` and `npm audit`, or `poetry check --lock`, `poetry install`, `poetry run pytest` and `pip-audit`. It's the body of the upgrade issue. Its first line is a marker that binds the plan to what was assessed:

```
<!-- standards-upgrade:plan {"version":1,"repo":"o/r","source":"3f1c…","policy":"standards-v2","digest":"sha256:…"} -->
```

The digest covers the whole assessment except its time, its requested ref and the commands' durations. A rerun on the same commit, policy, toolchain and advisory data gives the same digest.

## Deliver the plan

To deliver an assessment's plan, follow these steps:

1. Read `report.md` and `plan.md`. Edit the plan's text if you want, but keep its marker line as it is.
2. As an allow-listed collaborator, file `plan.md`'s contents as a new issue on the repository.
3. Check the issue and get the human-start handoff:

   ```bash
   node "$ECOSYSTEM_INSTALL_ROOT/standards-upgrade.mjs" apply --config CONFIG --issue ISSUE
   ```

   `ISSUE` is the number of the issue you filed.
4. Apply `start:implement` to the issue.

`apply` prints one JSON line with `issue`, the canonical issue `branch`, the plan marker fields, `task: "implement"` and `next`, which states that a person must apply the label. Its branch is `agent/issue-ISSUE`.

The operator applies `start:implement` to start Implement. Each later task also needs its own start label. Implement hardens the change, Verify reviews the current head and Land reads its prerequisites from GitHub. See [runtime runs](runtime-runs.md) and [Land](merge.md).


`apply` only reads. It refuses, with exit 2 and the reason on stderr, when:

- the issue isn't open, or is a pull request;
- its author isn't an allow-listed collaborator, or is a pipeline machine account;
- collaborator evidence is unreadable;
- it doesn't carry exactly one plan marker, or the marker doesn't parse;
- the marker names another repository, or a policy other than `standards-v2`;
- the config's base branch has moved past the plan's source commit;
- another open issue already carries a plan;
- the open issues can't be listed completely.

**Note:** `assess` reads GitHub's default branch, while `apply` checks the config's `baseBranch`, which is where the chain lands. When they differ, `apply` refuses the plan as stale. Assess with `--ref BASE_BRANCH` instead.

## Permissions

The assessment holds only the read side of the configured credentials, through the pipeline's own `gh` and `git` wrappers. It writes nothing to GitHub or the origin. Repository text, such as a README or a workflow, is data: it can't widen the target or the permissions.

Repository code may run only inside the assessment sandbox, without operator credentials or access to the operator's home. This is a separate isolation boundary from the read-only `apply` checks. The `apply` subprocess tests prove the human handoff, stale-head refusal and unreadable-collaborator hold; they do not constitute a fresh assessment-sandbox isolation proof.

Filing the upgrade issue needs a person. Only allow-listed input is trusted, and neither pipeline account is on the allow list, so an issue filed by the development account couldn't drive Implementation. An allow-listed collaborator files `plan.md` instead.

The plan never asks for a settings change. Requiring a check, archiving or changing access are owner actions that need separate administrative authority.

## Recovery

The assessment and `apply` write nothing to GitHub or the origin and keep no state, so rerunning them is always safe. The assessment's sandboxed work is deleted when it ends.

A new commit on the base branch makes a plan stale before Implementation starts. Close the stale issue, rerun the assessment and file the new plan. Once Implementation has started, Fix brings the branch up to date when Land finds it conflicting with the base, as it does for any issue.

An interrupted delivery keeps pushed commits and a retained private checkout. Read the branch and PR, preserve unpublished work and retry with a new start label. `apply` refuses another open upgrade plan; this uniqueness check does not claim a task start.
