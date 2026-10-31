# Writing a test

Tests follow the ISTQB levels in [project practices](../../../docs/project-practices.md#tests). Choose the lowest level that demonstrates the behavior. Put shared helpers under `support/` and reuse an existing kit before adding one.

| Level | Folder | Command | Dependencies |
| --- | --- | --- | --- |
| Component | `component/` | `npm run test:component` | Plain inputs |
| Component integration | `component-integration/` | `npm run test:component-integration` | Real files or subprocesses; fake external services |
| System | `system/` | `npm run test:system` | Built task apps, real local Git, fake GitHub and models |
| System integration | `system-integration/` | `npm run test:system-integration` | Explicit disposable external services; opt-in |
| Acceptance | `acceptance/` | `npm run test:acceptance` | One system test for each issue scenario |

The full gate discovers all non-external test levels with file concurrency 8 and a per-test deadline of 180000 ms. The root fast gate checks distribution types, lint, build and program syntax, then workspace checks. It does not run the host system suite.

## Task apps and launcher

Start from `support/task-app/task-app-test-kit.ts` for framework and launcher behavior. It runs the sample task app as buddies with distinct accounts against fake GitHub. A gate can hold a run until the test releases it. `acceptance/246-task-app-framework.test.ts` covers claims, overlapping runs and stops; `acceptance/248-task-app-launcher.test.ts` covers the built launcher. `system/runtime/launcher.test.ts` covers task program resolution and refusal, subprocess inputs, inherited credential filtering, account mismatch and shutdown draining. The Land acceptance file runs the real app over a local Git origin.

For built model-backed apps, use `system/runtime/buddy-flow-test-kit.ts`. Its `startTaskApp` runs an app with planned fake model sessions. `system/task-apps/implement.test.ts`, `verify.test.ts`, `system/gherkin.test.ts` and `system/runtime/fix-task-app.test.ts` demonstrate it. The review fixture supplies ordinary GitHub reviews and base-branch changes.

Assert on GitHub comments, reviews and PRs, pushed Git history, exit status or preserved work. Await the outcome itself; never sleep to pace a test. A timeout can fail a test but must not make a successful assertion true. Clean up every process, socket and temporary folder.

## Standalone tools

Safe Refactor fixtures live in `support/safe-refactor-test-kit.ts`. Project-policy tests use `support/project-policy-test-kit.ts`. Standards tests exercise the standalone entrypoint against local repositories and fake external services.

## Fake services

Fake GitHub lives under `support/signals/`. One long-lived server owns each disposable world. The `gh` on PATH forwards requests through `curl --unix-socket`, rather than starting a server per call. Fake pi lives beside the built task-app kit. Keep real credentials and models out of default tests.

## Acceptance

Name each test after its Gherkin scenario and put it at `acceptance/ISSUE-description.test.ts`. Given prepares observable inputs, When runs the app, and Then checks what a person or caller can observe. Do not substitute a successful mock for the task under test.

## Distribution tests

The root `test/system/distribution.test.ts` runs the real root build and installer
against isolated operator directories. Root `test/acceptance/272-distribution.test.ts`
runs all five installed tasks through the launcher with a separate data directory.
The task-flow kit also uses the real installer, including installer-owned prompts,
agent templates and support programs. Run these suites through root
`npm run check:full`; source gates never install into the operator environment.
