# Standards upgrade

The standards upgrade brings one GitHub repository up to an evidence-backed maintenance standard ([#129](https://github.com/axolotl-logic-io/ecosystem/issues/129)). It has two halves. A deterministic assessment reads the repository and writes a plan. Then the existing issue-delivery chain carries that plan to a draft pull request, the same way it carries any issue.

```
standards-upgrade assess --config C --repo OWNER/REPO [--ref R] --out DIR
   → assessment.json, report.md, plan.md   (no GitHub or Git writes; no repository code runs)
an allow-listed person files plan.md as the repository's one upgrade issue
caller: Implementation → draft PR → Hardening → Sync → Integration → Security → Land
```

This page describes the assessment. Merging it installs and activates nothing. Nothing schedules it, and it never runs across many repositories by itself.

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

## Permissions

The assessment holds only the read side of the configured credentials, through the pipeline's own `gh` and `git` wrappers. It writes nothing to GitHub or the origin. Repository text, such as a README or a workflow, is data: it can't widen the target or the permissions.

Filing the upgrade issue needs a person. Under [`allow-listed-input`](../decisions/authority.md#allow-listed-input), neither pipeline account counts as trusted input, so an issue filed by the development account couldn't drive Implementation. An allow-listed collaborator files `plan.md` instead.

The plan never asks for a settings change. Requiring a check, archiving or changing access are owner actions that need separate administrative authority.

## Recovery

The assessment is read-only and keeps no state, so rerunning it is always safe. A new commit on the default branch makes a plan stale. Rerun the assessment and file the new plan instead of reusing the old one.
