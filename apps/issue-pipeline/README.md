# Issue pipeline

The issue pipeline takes each allowed user's GitHub issue to a merged pull request with no human in the loop. An issue moves through four stages, each run by one stage job, and only three of them use a model. The wiki's [Reimagined pipeline](https://github.com/axolotl-logic/project-buddy/wiki/Reimagined-Pipeline) page is the design this code implements: its rules, and what it removed from the version before it.

A merge changes nothing that runs. Only the operator's install does (see Install).

## Stages and model roles

```text
author ──Gherkin──> implement ──verified, pushed──> review ──approve──> merge ──merged, published──> done
```

| Stage | Who works | What it produces |
|---|---|---|
| `author` | The **author** model, which only reads | One signed Gherkin comment on the issue, edited in place when the issue changes, or questions and `agent:needs-info` |
| `implement` | The **implementor** model, which writes | Commits on the issue's code and wiki branches, made only through `pipeline_commit`, verified by the repo's commands and pushed by the job |
| `review` | The **reviewer** model hardening the change, committing through `pipeline_commit` | The hardened head, with one signed review comment bound to the code head, wiki head and trusted inputs it saw |
| `merge` | The **reviewer** model integrating the change, committing, then reviewing the integrated result's security, only reading | The squash merge of the authorized head, the published wiki commits and the closed issue; a security finding blocks completion and publication |

An issue goes back when something changes: review's `changes` to implement, a failed merge check to implement, any new head after approval to review, and new trusted input from any stage to author. Every loop has a limit (`maxFixRounds`, `maxCiFixes`, `maxSyncs`, `maxConflictFixes`, `maxResumes`), and a stop is an `agent:stopped-<control>` label with a comment naming the control and how to resume. A provider's rate limit or a transport error defers the issue and backs the orchestrator off; it never stops it.

Each stage's role is in `src/roles/` (`author/`, `implementor/`, `reviewer/`, `merge/`), registered in `src/roles/registry.ts`. The agents the model sessions run as are in `agents/`: `issue-pipeline-author`, `-implementor` and `-reviewer`.

Each session's behavioral prompt is a page of the wiki clone the job's `--brain-path` names, chosen by the session's stage and phase: `Pipeline-Prompt-Author.md` (author), `-Developer.md` (implement), `-Hardening.md` (review, hardening), `-Integration.md` (merge, integration) and `-Security.md` (merge, security review). The job pins its stage's pages before it changes anything, recording each page's path, sha256 and the clone's HEAD in `job.json` (the usage records name the page, sha256 and HEAD), and pi gets a session's pinned text appended to its agent's system prompt (`--append-system-prompt`), so an edit to the clone mid-job changes no session. A missing or unreadable page fails the job; there is no bundled copy. Any other session, such as a reviewer session that names no phase, never starts. A page grants nothing: tools, tokens and commit scope come only from the session's spec (`commits` and `phase`, checked against `STAGE_AGENTS` in `src/job/roles.ts`).

## Programs

The build (`build.ts`) bundles each program in `src/` into one Node module in `dist/`, which the install copies to the pipeline root.

| Program | Source | What it does |
|---|---|---|
| `orchestrate.mjs` | `src/orchestrate.ts`, `src/orchestrator/` | `node orchestrate.mjs --config <path> --brain-path <wiki clone> [--once]`. The only process that starts stage jobs for its repo, so its jobs are the only claimants. Each tick it reads the open issues, schedules stage jobs within `maxJobs`, `stageCaps` and the merge window (one issue merges at a time), restarts dead jobs up to `maxResumes`, backs off after a rate limit, and logs each decision to `runs/<slug>/orchestrator.log`. An open issue saved `done` with what merged gets a merge job that only finishes it. |
| `job.mjs` | `src/job.ts`, `src/job/` | `node job.mjs --config <path> --issue N --stage <stage> --branch <name> --brain-path <wiki clone>`: one stage of one issue, on the branch its caller assigns, in its own checkout under `work/<slug>/jobs/`. It refuses a protected branch (the base, the wiki's branch, the remote's default) and pins each of its sessions' behavioral prompts from the wiki clone's `Pipeline-Prompt-*.md` pages before it changes anything, then claims the issue, runs the stage's role, saves the state, and prints one JSON line. `--steer <launch key> --message <text>` steers a running session; `--print-boundary` prints the stage's role, checkouts, environment and network and starts nothing. |
| `ops.mjs` | `src/ops.ts`, `src/ops/` | The only code that runs `git` and `gh` with the account's token. It reads one framed JSON request on stdin (`BEGIN_OPS_REQUEST` … `END_OPS_REQUEST`, naming the `op` and the `config`) and prints one JSON reply. The stage jobs run it; no model session holds a GitHub token. |
| `report.mjs` | `src/report.ts`, `src/report/` | `node report.mjs usage --config <path> [--since <date>] [--role <role>] [--issue <n>]`: the usage report from the sessions' usage records. The records are telemetry; nothing stops a session for what it spends. |
| `shell-supervisor.mjs` | `src/shell-supervisor.ts` | Runs each configured command in a process group of its own, so no command leaves a process behind. |
| `structured-output.mjs`, `pipeline-commit.mjs` | `src/job/structured-output.ts`, `src/job/pipeline-commit-tool.ts` | The pi extensions that give a session its schema-checked reply and its `pipeline_commit` tool. |

GitHub holds the state: the signed state comment on each issue, and the claim, Gherkin and review comments. Local files under the root (`clones/`, `work/`, `runs/`) are a disposable cache.

## Config

Each repo has a config in `$ISSUE_PIPELINE_ROOT/repos/`. `repos/example.json` sets every field the pipeline reads; `src/config-schema.ts` holds their defaults and shape. `models` names the model of each role: `author`, `implementor` and `reviewer`. A config written for the previous version still loads: its removed fields are ignored with a warning, and its old model roles map to the new ones as `src/config-legacy.ts` documents. With `wiki` set, the wiki is the repo's wiki submodule at `wiki.dir`, published to `wiki.branch` after the code merges.

## Install

The pipeline runs from an installed copy, never from this folder. Run `npm ci` at the repo root first, since the build needs esbuild:

```bash
npm ci                                      # at the repo root
mise //apps/issue-pipeline:install:dry-run  # list what would change, writing nothing outside dist/
mise //apps/issue-pipeline:install          # build and install
```

The install builds `src/` into `dist/` and stops if the build fails. It copies the programs and `repos/example.json` to `$ISSUE_PIPELINE_ROOT` (default `~/.pi/agent/issue-pipeline`) and the agents to `$PI_CODING_AGENT_DIR/agents/issue-pipeline/` (default `~/.pi/agent`), filling in `{{ISSUE_PIPELINE_ROOT}}` and `{{PI_CODING_AGENT_DIR}}`. It retires the files the previous version installed and this one no longer has: the old `workflow.js`, the old `issue-pipeline-escalation`, `-ops`, `-reader`, `-specifier` and `-writer` agents, and the `pipeline-start` and `pipeline-pause` prompts. Every file it replaces or retires is first copied to `$ISSUE_PIPELINE_ROOT-backups/<timestamp>-install/`, and a dry run lists them as `retired`. It records the commit in `INSTALLED.json`, refuses uncommitted changes in this folder unless given `--allow-dirty`, and refuses to install from inside the pipeline root.

Per-repo configs, their setup and teardown scripts, `secrets/`, `clones/`, `work/` and `runs/` stay local, and the install never touches them.

## Tests

```bash
mise //apps/issue-pipeline:check      # typecheck, lint, build, then every test
mise //apps/issue-pipeline:typecheck  # tsc on src/ and build.ts, then on install.mjs and the tests as checked JavaScript
mise //apps/issue-pipeline:lint       # Biome with the repo's policy
mise //apps/issue-pipeline:build      # build src/ into dist/
```

The tests run against temporary pipeline roots, local bare git origins, a fake `gh` (`test/fake-gh.mjs`) and a fake pi (`test/fake-rpc-pi.mjs`), never a real model or GitHub. A test sets its temporary root, and HOME where it matters, before it imports anything from `src/`, since the root is read once on import.
