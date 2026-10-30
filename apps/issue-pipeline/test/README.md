# Writing a test

Tests are sorted by ISTQB test level, as the [project practices](../../../docs/project-practices.md#tests) define them. Pick the lowest level that can show the behavior, put the file in that level's folder under its subject's path, and start from the kit this page names.

```
test/
  component/                 one module on its own
  component-integration/     modules together, or with real Git, files or processes
  system/                    the whole built program
  system-integration/        the program against real GitHub or a real model (opt-in)
  acceptance/                an issue's Gherkin scenarios, run against the system
  support/                   kits more than one level uses
```

| Level | Real | Fake | Start from | Run | In `check:full` |
| --- | --- | --- | --- | --- | --- |
| Component | the module | its inputs | nothing | `npm run test:component` | yes |
| Component integration | Git, files, subprocesses | GitHub, pi | `support/signals/signal-test-kit.ts`, `support/project-policy-test-kit.ts` | `npm run test:component-integration` | yes |
| System | the built `buddy.mjs` and its ops | GitHub, pi | `system/runtime/buddy-flow-test-kit.ts` | `npm run test:system` | yes |
| System integration | GitHub or a model | nothing | `system/runtime/buddy-flow-test-kit.ts` | `npm run test:system-integration` | no |
| Acceptance | as system | as system | `system/runtime/buddy-flow-test-kit.ts` | `npm run test:acceptance` | yes |

A new level folder needs no setup: its script already exists, and a script with no tests passes. The examples below are sketches: names in capitals stand for the test's own constants, and helpers like `bareOrigin` stand for a few lines you write or find in a kit.

## Component

Import the module and call it. Give it plain values and assert on what it returns or throws.

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readRecords } from "../../src/tasks/records.ts";

test("a record another account wrote grants nothing", () => {
  const records = readRecords(CFG, 7, [commentBy("visitor", RESULT)]);
  assert.deepEqual(records.rows, []);
});
```

A module that reads `ISSUE_PIPELINE_ROOT` or other environment when it loads needs that set first. Set it, then load the module with `await import(...)`.

## Component integration

Give the code a real dependency in a temporary folder: a Git repository, files, or a child process. Fake GitHub comes from `support/signals/`, and it serves the world that `baseWorld()` builds.

```ts
import { harness, labelledIssue, openPull, review, taskAnswers } from "../../support/signals/signal-test-kit.ts";

test("a member's request for changes on the PR's head is delivered once", () => {
  const kit = harness((world) => {
    world.issues.push(labelledIssue(ISSUE, "start:implement", "autumn", EVENT));
    world.tasks.push(taskAnswers(ISSUE));
    world.pulls = [openPull(ISSUE, PR)];
  });
  const head = kit.push(ISSUE);           // a real commit on the PR's branch
  kit.change((world) => {
    world.pulls?.[0]?.reviews?.push(review(ID, "autumn", "CHANGES_REQUESTED", head));
  });
  assert.equal(kit.poll().signals.length, 1);
  assert.deepEqual(kit.poll().signals, []);
});
```

`component-integration/signals/review-signals.test.ts` and `task-starts.test.ts` are full examples.

## System

Run the built program the way an operator does. `machine()` builds a temporary pipeline root, a local Git origin, fake GitHub and fake pi. `runBuddy()` runs `buddy` with the model sessions you plan, and stops it at a poll you choose.

```ts
import { machine } from "./buddy-flow-test-kit.ts";

test("a started issue gets a PR", async () => {
  const box = machine(); // ISSUE already carries an authorized start:implement
  try {
    const { status } = await box.runBuddy([IMPLEMENT], 2);
    assert.equal(status, 0);
    assert.equal(box.world().pulls?.length, 1);
  } finally {
    box.cleanup();
  }
});
```

Assert on what a person would see: GitHub's world, the origin's branches, and the observation files. Wait for an outcome with `box.when(() => …)`, never a delay.

A test of Verify, Fix or Land starts from a PR another buddy opened. `system/runtime/buddy-flow-review-test-kit.ts` and `buddy-flow-land-test-kit.ts` run Implement first and hand you that PR. `buddy-flow-verify.test.ts` and `buddy-flow-land.test.ts` show them in use.

## System integration

These tests use real GitHub or a real model, so they need credentials and cost money or rate limit. `check:full` leaves them out. Run them yourself with `npm run test:system-integration`, which runs one file at a time.

- Use a disposable repository that holds nothing else, and read its name and tokens from the environment.
- When a variable is missing, fail with a message naming it. Don't skip: Biome's `noSkippedTests` forbids it.
- Clean up what the test made on GitHub in `finally`, such as branches, PRs and labels.

## Acceptance

Author writes an issue's requirements as Gherkin. An acceptance test turns each scenario into one test, named after it. It uses the system kit: **Given** sets up the world, **When** runs the buddy, and **Then** asserts on what a person can see.

```gherkin
Scenario: Verify approves a head with only nits
  Given a PR whose head has only naming nits
  When Verify reviews it
  Then the PR has an approving review on that head
```

```ts
test("Scenario: Verify approves a head with only nits", async () => {
  const box = machine(withNitOnlyPr);              // Given
  try {
    await box.runBuddy([VERIFY_NITS], 2);          // When
    const [review] = box.world().pulls?.[0]?.reviews ?? []; // Then
    assert.equal(review?.state, "APPROVED");
  } finally {
    box.cleanup();
  }
});
```

Put the file at `acceptance/<issue number>-<short name>.test.ts`, so the test leads back to its requirements.

## Kits and fakes

Look in `support/` and the level's own folder before writing a helper, and extend what's there. A kit used by more than one level belongs in `support/`, under its subject's path. Fakes are named `fake-*.ts`, fixtures `*-fixtures.ts` and kits `*-test-kit.ts`.

Task app tests start from `support/task-app/task-app-test-kit.ts`. It runs the sample task app, `support/task-app/sample-task-app.ts`, as two buddies with their own accounts against fake GitHub, and can hold a run live at its gate. `acceptance/246-task-app-framework.test.ts` shows it in use. To test the buddy as a launcher, the kit installs the sample app as other tasks' apps in the pipeline root, runs `src/buddy.ts` with a launcher buddy file and reads each app's exit from the buddy's log; see `acceptance/248-task-app-launcher.test.ts`.

A fake external service is one long-lived server per test machine, not a process per call. Fake GitHub is `support/signals/fake-gh-server.ts`. The `gh` on the machine's `PATH` is a small sh script that forwards each call to it with `curl --unix-socket`.

`fake-gh-service.ts` and `startFakeGhTransport` share that protocol and process startup across the signal/runtime fake and the reservation fake in `component-integration/fake-coordination-gh.ts`. Reservation scenarios pass their native test signal to each driver, await driver closure before teardown, and stop their owned service between cases. A cancelled driver retains its evidence and prevents later scenarios from starting; expected negative driver results do not count as cancellation.
