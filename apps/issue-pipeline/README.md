# Issue pipeline

The issue pipeline turns GitHub issues into merged pull requests: a pi-subagents workflow that triages each issue, opens a PR, writes a spec, implements, reviews, fixes, verifies and merges. See the wiki's [Issue pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Issue-Pipeline) page for its goal, rules and design, [Running the issue pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Running-the-Issue-Pipeline) for the operating manual, and [Agent labels](https://github.com/axolotl-logic/project-buddy/wiki/Agent-Labels) for its labels.

## Files

| Path | What it is |
|---|---|
| `src/workflow.js` | The sweep's body: it starts the sweep's driver and awaits each batch of launches the driver asks for, chained one after another; the build ends it by returning the driver's summary. Runs in the pi-subagents sandbox and uses no model tokens itself. |
| `src/workflow/` | The sweep, as strict TypeScript. `sweep.ts` is its driver, `startSweep`: it owns the sweep's state and runs the sweep op, the claim (`stages/entry.ts`), the stage groups (`sweep-stages.ts`), closing parents, the release and the summary, and returns each next batch of launches for `workflow.js` to await. `stages/` holds the stages on the step machine: each is a sync `next` that takes the issue's JSON-safe state and its last launches' results and returns its next launches or `done`, run through the stage dispatch (`stages/index.ts`) in four groups: triage, spec, implement and open-pr; review and the fix rounds; sync and checks; accept, security and merge. The last two groups run once more when merge finds the branch behind its base, so it rebases and merges in the same sweep (#205). `launches.ts` builds the launch specs and `launch-results.ts` reads their results; `sweep-config.ts` reads the run's args and holds the default budgets, models and spawn cap and the stage facts. `batches.ts` chains the driver's batches with a promise chain, since pi-subagents rejects nested async functions, and `index.ts` exports the one `helpers` object `workflow.js` reads the driver and `driveBatches` from. |
| `src/ops.ts` | The ops CLI's entry: the only code that runs `git` and `gh` or reads tokens, called through the `issue-pipeline-ops` agent. It parses the request's envelope and dispatches each op; its helpers live in `src/*.ts`. |
| `src/ops/` | The ops in strict TypeScript, one module per op (`sweep`, `claim`, `save-state`, `ask`, `split`, `stop` (#183); `pr` and `sync` (#184); `verify`, with `fails-before-fix`, and `ci-status` (#185); `merge` and `finish` (#186); `cleanup`, which frees closed issues' worktrees at the end of each sweep (#174); `wiki-check`, which checks the links in an issue's changed wiki pages and that new pages are linked (#215)), which `src/ops.ts` imports and registers. Each op parses its own request. |
| `src/job.ts`, `src/job/` | The stage job's CLI (#232, #233): one sweep pinned to one issue that begins only one stage, printing its summary as one JSON line; it can be stopped, resumed and steered. `args.ts` reads its arguments. `launch.ts` runs each launch as a child process (`ops.mjs`, or `pi --mode rpc` as the launch's installed agent, `agent-definition.ts`, through `rpc.ts`, which sends the prompt and commands and reads pi's records), `status.ts` keeps the issue's `job.json` (each launch's pid, session, last event, tool failures, usage and outcome) and reads it for `--resume` and `--steer`, `control.ts` owns the live sessions, the steer socket and the stop on SIGTERM or SIGINT, `raw-results.ts` maps the exits and session records to the results `launch-results.ts` reads, `pool.ts` runs each batch up to the spawn cap, `structured-output.ts` is the pi extension that gives a session its terminating `structured_output` tool, and `roles.ts` (#249) holds each stage's and session's role (reader, writer or merger), the config's `jobRoles`, and the env each `pi` gets: no gh token variables, and `GH_TOKEN` only for a writer or merger whose `jobRoles.<role>.tokenEnv` is set; ops keep the job's env. `checkout.ts` (#250) gives each job its own checkout, `work/<slug>/jobs/issue-N-<stage>`, cloned from the bare mirror `work/<slug>/mirror.git` (and its wiki from `wiki-mirror.git`); every pi session runs there and every ops request names it in its `checkout` field. On exit it records and drops what the checkout left uncommitted (`job.json`'s `lostChanges`), `exit-push.ts` runs the push op for a writer with unpushed commits, unpushed wiki commits wait in the wiki mirror's `agent/issue-N`, and the checkout is removed. `--print-boundary` prints a stage job's role, checkout, env names and network as one JSON line and starts nothing. See "Stage jobs" in the wiki's Running-the-Issue-Pipeline page. |
| `build.ts` | Builds `src/` into `dist/` with esbuild: the workflow's helpers are bundled into an IIFE placed ahead of the sweep's body, which is transformed alone, keeping its top-level `await`, and given its `return sweep.summary();`, since Biome can't parse a top-level `return`; ops, the stage job and its pi extension are each bundled into one Node ES module. |
| `dist/` | The build's output, `workflow.js`, `ops.mjs`, `job.mjs` and `structured-output.mjs`, which the install copies. Ignored by git and Biome. |
| `agents/` | The four agents: `issue-pipeline-ops` (command runner), `-reader` (read-only), `-specifier` (read-only plus web search) and `-writer`. The three model agents also get `codemode`, which scripts calls to their own tools only, so it grants nothing new. |
| `prompts/` | `/pipeline-start` and `/pipeline-pause`, which start and pause a lane in a pi session. |
| `repos/example.json` | Every field of a per-repo config. |
| `install.mjs` | Builds, then installs this folder where pi reads it. |
| `test/` | Tests for `src/ops.ts`, `src/workflow.js`, `build.ts` and `install.mjs`, and the harness that runs the built workflow with scripted replies. |

`build.ts` is strict TypeScript, run by Node's type stripping and checked by `tsc` (`tsconfig.json`, which also covers `src/**/*.ts`). The workflow's helpers in `src/workflow/` and the ops CLI, `src/ops.ts` with its modules in `src/*.ts` and `src/ops/`, are typed too. `install.mjs` and the tests are checked JavaScript, typed with JSDoc and checked by `tsc` through `tsconfig.test.json`, which turns on `checkJs`. Only the sweep's body, `src/workflow.js`, is plain JavaScript outside `tsc`, because `allowJs` is off: the sandbox runs it as an async function body with its own globals, which `biome.jsonc` declares for it, and the build adds its `return`, since Biome can't parse a top-level one. `mise //apps/issue-pipeline:check` typechecks, lints (Biome, with the repo's policy), builds and tests all of it.

`{{ISSUE_PIPELINE_ROOT}}` and `{{PI_CODING_AGENT_DIR}}` in the agents and prompts are filled in by the install.

## Install

The pipeline runs from an installed copy, not from this folder. Run `npm ci` at the repo root first, since the build needs esbuild:

```bash
npm ci                                      # at the repo root
mise //apps/issue-pipeline:install:dry-run  # list what would change
mise //apps/issue-pipeline:install          # install
```

It first builds `src/` into `dist/` (as `mise //apps/issue-pipeline:build` does), and stops with `install: build failed` if the build fails. A dry run writes only `dist/`. Then it copies the generated `dist/workflow.js`, `dist/ops.mjs`, `dist/job.mjs` and `dist/structured-output.mjs`, and `repos/example.json`, to `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`), the agents to `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` and the prompts to `$PI_CODING_AGENT_DIR/prompts/` (default `~/.pi/agent`). It backs up each file it replaces to `$ISSUE_PIPELINE_ROOT-backups/<timestamp>-install/` and records the commit in `INSTALLED.json`. It refuses a checkout with uncommitted changes in this folder unless given `--allow-dirty`, and refuses to install from the pipeline's own worktrees.

Merging a PR changes nothing that runs: only the operator's install does. That way an agent's PR can't change the code that checks its own work. Install from a checkout of a merged commit, between sweeps or with the lanes paused (`/pipeline-pause`). Every op reads `ops.mjs` fresh, but a schedule keeps the `workflow.js` text it was created with, so recreate the lanes after a change to it.

Each repo's config, its setup and teardown scripts and its token stay local in `$ISSUE_PIPELINE_ROOT/repos/` and `secrets/` (`per-repo-config-kept-local`), as do `clones/`, `work/` and `runs/`. The install never touches them.

## Tests

```bash
mise //apps/issue-pipeline:check      # typecheck, lint, build, then the tests
mise //apps/issue-pipeline:build      # build src/ into dist/
mise //apps/issue-pipeline:lint       # Biome with the repo's policy (npm run lint)
mise //apps/issue-pipeline:typecheck  # tsc on build.ts and src/**/*.ts, then on install.mjs and every test file (tsconfig.test.json)
```

The `test/workflow-stages-*.test.mjs` scenarios run the built workflow through `test/workflow-harness.mjs` with scripted replies, and pin each stage's launches in `.snapshot` files beside them: each launch's key, agent and label, and an ops launch's request. After an intended change to the workflow, refresh them from this folder with `node --test --test-update-snapshots 'test/workflow-stages-*.test.mjs'`, and review the snapshot diff before committing it.
