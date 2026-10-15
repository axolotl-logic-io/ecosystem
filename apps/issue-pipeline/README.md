# Issue pipeline

The issue pipeline turns GitHub issues into merged pull requests: a pi-subagents workflow that triages each issue, opens a PR, writes a spec, implements, reviews, fixes, verifies and merges. See the wiki's [Issue pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Issue-Pipeline) page for its goal, rules and design, [Running the issue pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Running-the-Issue-Pipeline) for the operating manual, and [Agent labels](https://github.com/axolotl-logic/project-buddy/wiki/Agent-Labels) for its labels.

## Files

| Path | What it is |
|---|---|
| `src/workflow.js` | The sweep. Runs in the pi-subagents sandbox and uses no model tokens itself. |
| `src/ops.mjs` | The only code that runs `git` and `gh` or reads tokens, called through the `issue-pipeline-ops` agent. |
| `build.ts` | Builds `src/` into `dist/` with esbuild: the workflow is transformed alone, keeping its top-level `await` and `return`; ops is bundled into one Node ES module. |
| `dist/` | The build's output, `workflow.js` and `ops.mjs`, which the install copies. Ignored by git and Biome. |
| `agents/` | The four agents: `issue-pipeline-ops` (command runner), `-reader` (read-only), `-specifier` (read-only plus web search) and `-writer`. |
| `prompts/` | `/pipeline-start` and `/pipeline-pause`, which start and pause a lane in a pi session. |
| `repos/example.json` | Every field of a per-repo config. |
| `install.mjs` | Builds, then installs this folder where pi reads it. |
| `test/` | Tests for `src/ops.mjs`, `src/workflow.js`, `build.ts` and `install.mjs`, and the harness that runs the built workflow with scripted replies. |

`build.ts` is strict TypeScript, run by Node's type stripping and checked by `tsc` (`tsconfig.json`, which also covers `src/**/*.ts`). The sources in `src/` are still untyped JavaScript, outside `tsc` because `allowJs` is off: they don't meet the coding practices yet, which #162 tracks.

`{{ISSUE_PIPELINE_ROOT}}` and `{{PI_CODING_AGENT_DIR}}` in the agents and prompts are filled in by the install.

## Install

The pipeline runs from an installed copy, not from this folder. Run `npm ci` at the repo root first, since the build needs esbuild:

```bash
npm ci                                      # at the repo root
mise //apps/issue-pipeline:install:dry-run  # list what would change
mise //apps/issue-pipeline:install          # install
```

It first builds `src/` into `dist/` (as `mise //apps/issue-pipeline:build` does), and stops with `install: build failed` if the build fails. A dry run writes only `dist/`. Then it copies the generated `dist/workflow.js` and `dist/ops.mjs`, and `repos/example.json`, to `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`), the agents to `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` and the prompts to `$PI_CODING_AGENT_DIR/prompts/` (default `~/.pi/agent`). It backs up each file it replaces to `$ISSUE_PIPELINE_ROOT-backups/<timestamp>-install/` and records the commit in `INSTALLED.json`. It refuses a checkout with uncommitted changes in this folder unless given `--allow-dirty`, and refuses to install from the pipeline's own worktrees.

Merging a PR changes nothing that runs: only the operator's install does. That way an agent's PR can't change the code that checks its own work. Install from a checkout of a merged commit, between sweeps or with the lanes paused (`/pipeline-pause`). Every op reads `ops.mjs` fresh, but a schedule keeps the `workflow.js` text it was created with, so recreate the lanes after a change to it.

Each repo's config, its setup and teardown scripts and its token stay local in `$ISSUE_PIPELINE_ROOT/repos/` and `secrets/` (`per-repo-config-kept-local`), as do `clones/`, `work/` and `runs/`. The install never touches them.

## Tests

```bash
mise //apps/issue-pipeline:check      # typecheck, build, then the tests
mise //apps/issue-pipeline:build      # build src/ into dist/
mise //apps/issue-pipeline:typecheck  # tsc on build.ts
```

The `test/workflow-stages-*.test.mjs` scenarios run the built workflow through `test/workflow-harness.mjs` with scripted replies, and pin each stage's launches in `.snapshot` files beside them: each launch's key, agent and label, and an ops launch's request. After an intended change to the workflow, refresh them from this folder with `node --test --test-update-snapshots 'test/workflow-stages-*.test.mjs'`, and review the snapshot diff before committing it.
