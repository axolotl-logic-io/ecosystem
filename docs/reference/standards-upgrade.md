# Standards upgrade

The standards upgrade brings one GitHub repository up to an evidence-backed maintenance standard ([#129](https://github.com/axolotl-logic-io/ecosystem/issues/129)). It has two halves. A deterministic assessment reads the repository and writes a plan. Then the existing issue-delivery chain carries that plan to a draft pull request, the same way it carries any issue.

```
standards-upgrade assess --config C --repo OWNER/REPO [--ref R] --out DIR
   → assessment.json, report.md, plan.md   (no GitHub or Git writes; no repository code runs)
an allow-listed person files plan.md as the repository's one upgrade issue
standards-upgrade apply --config C --issue N
   → the branch and the caller's start line   (read-only checks)
caller: Implementation → draft PR → Hardening → Sync → Integration → Security → Land
```

This page describes the assessment and the admission of its plan. Merging them installs and activates nothing. Nothing schedules it, and it never runs across many repositories by itself.

## Scope of this slice

The assessment supports Node/npm repositories only. Every other ecosystem, including Python/Poetry, Go and native builds, gets the disposition `unsupported` and the verdict `blocked`. The assessment names the toolchains it saw instead of guessing at an upgrade.

The assessment is static. It runs no repository code, because no credential-free sandbox with enforced filesystem and network limits exists yet. Installing, running tests and scanning advisories would run that code. So those three criteria are always `unverified`, and a Node/npm assessment can never reach `acceptable`. The upgrade's Implementation and Hardening runs execute those checks later, as they do for any configured repository.

## Run an assessment

To assess the configured repository at its default branch, run from the repository root:

```bash
npm run build --workspace @ecosystem/issue-pipeline
node apps/issue-pipeline/dist/standards-upgrade.mjs assess \
  --config CONFIG --repo OWNER/REPO --out OUT_DIR
```

- `CONFIG` is the target repository's pipeline config, as `docs/reference/operations.md` describes. The assessment reads GitHub with its `mergeAccount` credential, for reads only, as the Gatekeeper's Integration task does.
- `OWNER/REPO` names the repository, either as a slug or as its canonical URL, such as `https://github.com/OWNER/REPO`. It must be the config's `repo`.
- `OUT_DIR` is an existing, empty folder outside any checkout.

_Optional:_ Add `--ref REF` to assess a branch, tag, full ref or full commit instead of the default branch.

The command prints one JSON line:

```json
{"verdict":"not-acceptable","disposition":"node-npm","source":"3f1c…","assessment":"OUT_DIR/assessment.json","report":"OUT_DIR/report.md","plan":"OUT_DIR/plan.md"}
```

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
| `unsupported` | Anything else | `blocked` | The toolchains it saw are named. No plan. |

A scaffold check looks at every branch and tag, not just the default branch. A repository with code on any branch isn't a scaffold.

## Criteria

Each criterion has one status: `passed` (verified pass), `failed` (evidenced failure), `unverified` or `not-applicable`.

| Criterion | Passes when |
|---|---|
| `environment.manifest` | The root `package.json` parses as a package manifest. |
| `environment.toolchain` | `engines.node`, `.nvmrc` or `.node-version` declares the supported Node. |
| `environment.lockfile` | `package-lock.json` or `npm-shrinkwrap.json` is committed. A publishable library may omit one (`not-applicable`). A yarn, pnpm or bun lockfile is `unverified`. |
| `environment.install` | Always `unverified`: no repository code runs. |
| `vulnerabilities.scan` | Always `unverified`: no scanner ran, so this isn't a clean scan. |
| `behavior.tests` | A real `test` script exists. A missing one, or npm's placeholder, means zero tests. |
| `behavior.tests-run` | Always `unverified`: no repository code runs. |
| `ci.triggers` | A workflow runs on `pull_request`, and one runs on `push` to the default branch. |
| `ci.runs-tests` | A workflow step runs `npm test`, or `npm run test`, `check` or `ci`. |
| `ci.failure-propagation` | No `continue-on-error`, and no `\|\| true` or `--if-present` on a test command. |
| `ci.advisory-refresh` | Dependabot is configured, or a workflow runs on a schedule. |
| `ci.workspaces` | With workspaces, CI or the root test script runs `--workspaces`. One component is `not-applicable`. |
| `ci.workflow-syntax` | Present only when a workflow file doesn't parse; then `failed`. |
| `enforcement.required-checks` | Branch protection or a ruleset requires a check. A read GitHub refuses makes it `unverified`, never `failed` or `passed`. |

The verdict follows from the statuses. Any `failed` gives `not-acceptable`. Otherwise any `unverified` gives `unverified`. Only all `passed` or `not-applicable` gives `acceptable`.

A green workflow never stands in for enforcement. Without a required check, the verdict can't be `acceptable`.

## Results

`assessment.json` follows the `ASSESSMENT` schema in [`src/standards/schema.ts`](../../apps/issue-pipeline/src/standards/schema.ts). The entrypoint validates it before writing. It records:

- the repository, the requested ref, the resolved ref and the full source commit;
- the assessment time, the policy version (`standards-v1`) and the Node and Git versions;
- the disposition, the components, the workflows and the required checks;
- each criterion's status and evidence, and the verdict;
- the proposed changes, each tied to a criterion;
- the owner actions, which need separate authority, such as requiring a check or archiving;
- the repository commands it ran, which is always none.

`report.md` shows the same data for people.

`plan.md` exists only for a `node-npm` assessment with something to change. It's the body of the upgrade issue. Its first line is a marker that binds the plan to what was assessed:

```
<!-- standards-upgrade:plan {"version":1,"repo":"o/r","source":"3f1c…","policy":"standards-v1","digest":"sha256:…"} -->
```

The digest covers the whole assessment except its time and requested ref. A rerun on the same commit, policy and toolchain gives the same digest.

## Deliver the plan

To deliver an assessment's plan, follow these steps:

1. Read `report.md` and `plan.md`. Edit the plan's text if you want, but keep its marker line as it is.
2. As an allow-listed collaborator, file `plan.md`'s contents as a new issue on the repository.
3. Check the issue and get the caller's start line:

   ```bash
   node apps/issue-pipeline/dist/standards-upgrade.mjs apply --config CONFIG --issue ISSUE
   ```

   `ISSUE` is the number of the issue you filed.
4. Start the Implementation stage with the printed line, filling in the caller's run folder and lane, as the [caller](caller.md) page describes.

`apply` prints one JSON line with the issue, the branch `standards-upgrade/issue-ISSUE`, the plan's marker fields, the stage `implement` and the start line. From there the existing caller and task chain do everything: Hippy implements on that branch and opens a draft PR, and Hardening, Sync, Integration, Security and Land follow under their usual rules. The default run never merges by itself; landing still needs the chain's own Security result and authorization.

`apply` only reads. It refuses, with exit 2 and the reason on stderr, when:

- the issue isn't open, or is a pull request;
- its author isn't an allow-listed collaborator, which includes both pipeline accounts;
- it doesn't carry exactly one plan marker, or the marker doesn't parse;
- the marker names another repository, or a policy other than `standards-v1`;
- the config's base branch has moved past the plan's source commit;
- another open issue already carries a plan;
- the open issues can't be listed completely.

**Note:** `assess` reads GitHub's default branch, while `apply` checks the config's `baseBranch`, which is where the chain lands. When they differ, `apply` refuses the plan as stale. Assess with `--ref BASE_BRANCH` instead.

## Permissions

The assessment holds only the read side of the configured credentials, through the pipeline's own `gh` and `git` wrappers. It writes nothing to GitHub or the origin. Repository text, such as a README or a workflow, is data: it can't widen the target or the permissions.

Filing the upgrade issue needs a person. Under [`allow-listed-input`](../decisions/authority.md#allow-listed-input), neither pipeline account counts as trusted input, so an issue filed by the development account couldn't drive Implementation. An allow-listed collaborator files `plan.md` instead.

The plan never asks for a settings change. Requiring a check, archiving or changing access are owner actions that need separate administrative authority.

## Recovery

The assessment and `apply` are read-only and keep no state, so rerunning them is always safe.

A new commit on the base branch makes a plan stale before Implementation starts. Close the stale issue, rerun the assessment and file the new plan. Once Implementation has started, the chain's own Sync task brings the branch up to date, as it does for any issue.

An interrupted or rate-limited delivery recovers through the chain's existing rules. Every restart is a retry from the latest checkpoint, and an uncertain write is reconciled by reading, never repeated. One work item and one branch per repository keep a second run from writing the same branch. `apply` refuses a second open plan, so a resumed upgrade continues its existing issue instead of filing another.
