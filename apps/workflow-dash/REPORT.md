# Dashboard import validation

Date: 2026-10-22. Source base: ecosystem `b485cf1`, branch `feat/workflow-dash`. These results validate the source import, not an installed dashboard or operator acceptance run.

## Source changes

- Imported the standalone extension into `apps/workflow-dash/`, with npm workspace and Pi metadata, pinned Pi 1.2.0 development dependencies, mise tasks and an independent CI job. The [old local report](docs/history/local-dash-report.md) is historical evidence only.
- Added portable configuration, `buddyRuns` precedence over deprecated `agentRuns` and `operators`, and canonical `--workflow-dash` activation with the deprecated flag retained.
- Added Buddy runs and validated, explicitly recorded account metadata. Missing accounts, tasks, bindings and parents remain unknown. Collection still covers Pi subagent records, not every buddy or model-free execution.
- Preserved raw identifiers and historical records. Legacy merge describes intended Sync/Integration/Security/Land/Completion coverage without claiming a current task, result or permission.
- Preserved tri-state process observations and unknown configured capacity. Deprecated tools alone retain historical numeric display assumptions and their existing JSON contracts.
- Preserved editable requests, cancellation, new linked retries, uncertain-write reconciliation, attempt budgets and held resources with unknown consumers. No direct workflow controls were added.

## Design refactor

The initial import exposed 965 lint errors. The refactor resolves them under the inherited policy rather than suppressing them:

- External JSON remains unknown until source-specific Zod validation. Nullable historical observations remain null, and raw launch keys and stage identifiers remain unchanged.
- Local files, process observations, workflows, sessions, buddy records and GitHub reads have owning modules. Snapshot assembly does not serve as a compatibility barrel. Collection uses bounded worker pools.
- Presentation, source-key navigation, modal interaction, lifecycle, requests and tool output have separate responsibilities. Discriminated selections replace numeric-tab-plus-untyped-item dispatch.
- Runtime generations prevent stale publication after stop or restart. Concurrent refresh callers await the same collection, and old completions cannot clear newer work. Activity derives from context rather than a second boolean.
- Typed fixtures and narrow host capabilities replace loose mocks. Copied fixture bytes stay unchanged; tests materialize JSON filenames in temporary directories. Built-in dark/light themes replace personal theme assumptions.

The narrow Node process-boundary and Pi-required default-export exceptions remain documented. No design/type rules or test assertions were disabled to obtain a passing gate.

## Check results

Commands ran from the repository root:

| Check | Result |
| --- | --- |
| `mise //apps/workflow-dash:check` | Passed: TypeScript, 108 tests and Biome over 60 files; no failures, cancellations, skips or todo tests |
| `mise //apps/issue-pipeline:check` | Passed: typecheck, lint, build, executable syntax checks and 2,055 tests; no failures, cancellations, skips or todo tests |

The complete pipeline gate took approximately 1,023 seconds. An earlier 900-second attempt was incomplete and is not counted as passing evidence. Its owned process group was verified and stopped. The successful run had an adequate deadline and exited normally.

Local investigation logs are `/tmp/dash-check.log` and `/tmp/dash-pipeline-check.log`. These temporary files are not release artifacts or CI evidence.

## Coverage and limits

Tests cover dark/light rendering at 40/80/110/160/220 columns, inactive modes, cancellation and steering, source identifiers, canonical/deprecated tool contracts, malformed and nullable records, uncertain process observations, task coverage, configuration aliases and explicit versus missing accounts. Lifecycle regressions cover stop during configuration or collection, refresh coalescing, restart generations and recovery after collection failure.

On 2026-10-24, #164 removed the direct-call cases among these: rendering, tool contracts, records, observations, templates, labels and configuration aliases. The [removal ledger](../../docs/decisions/unit-test-removal-164.md#workflow-dash) lists them.

Tests use synthetic process probes, mocked host delivery and disposable filesystem roots. They do not probe fixture PIDs, activate a live extension or call a real model. Pending requests, bounded logs and lists, absent parent/task/result bindings, unverified account metadata and historical deprecated capacity assumptions retain the [documented observation limits](README.md#observation-limits).

## Runtime boundary

The original `~/workspace/tools/pipeline-dash/` directory and active extension symlink remain unchanged. Source delivery does not install or activate the dashboard. Operator acceptance and persistent cutover require separate authorization and one active copy with a preserved rollback entry.

Retiring Legacy merge also requires delivered, installed and verified task/result/binding evidence and a tested reader. Passing source gates does not establish that evidence. The assessment app itself has not been implemented.
