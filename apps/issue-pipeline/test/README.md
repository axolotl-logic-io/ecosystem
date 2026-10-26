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
test("Land refuses a target that moved after it was read", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "land-"));
  try {
    const origin = bareOrigin(root);   // git init --bare, one commit on main
    // … move main, then call the code and assert on the refusal …
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

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
    const [review] = box.world().reviews;          // Then
    assert.equal(review?.state, "APPROVED");
  } finally {
    box.cleanup();
  }
});
```

Put the file at `acceptance/<issue number>-<short name>.test.ts`, so the test leads back to its requirements.

## Kits and fakes

Look in `support/` and the level's own folder before writing a helper, and extend what's there. A kit used by more than one level belongs in `support/`, under its subject's path. Fakes are named `fake-*.ts`, fixtures `*-fixtures.ts` and kits `*-test-kit.ts`.

A fake external service is one long-lived server per test machine, not a process per call. Fake GitHub is `support/signals/fake-gh-server.ts`. The `gh` on the machine's `PATH` is a small sh script that forwards each call to it with `curl --unix-socket`.
