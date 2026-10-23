# Code and test decisions

These decisions cover how the pipeline's own code and tests behave. The repository's code, lint and test rules are in the shared [coding practices](../coding-practices.md) and this repository's [project practices](../project-practices.md).

## tests-pin-promised-behaviour

Tests pin promised behavior, not internals: reply shapes, stop codes and labels, configured limits, GitHub-visible effects and regressions. Don't assert on copied constants, prompt text, call order or whole-trace snapshots.

## no-unit-tests

On 2026-10-22, Autumn decided that ecosystem and project-buddy have no unit tests. This rejects the earlier rule, "logic gets a unit test", and the project-level rule, "a module's logic gets a unit test".

Tests exercise behaviour through a real dependency or the whole system. Integration and feature-entrypoint tests, including browser integrations, need not cover a full application flow. A filesystem guard validates actual artifacts; importing a module is not a filesystem-backed test. An isolated direct call with no real dependency is a unit test and is not written. A controlled fake GitHub or fake pi used across real jobs and ops remains valid.

Issue #164 removes the pipeline's isolated direct-call tests and their unused helpers without replacement tests or production behaviour changes. The [removal ledger](unit-test-removal-164.md) lists every removed case, including lost safety, authorization, credential and validation assertions. Retained flows are not equivalent replacements for those decision matrices. The documented opt-in discovery interface stays, without its former unit coverage.

## commands-leave-no-processes

Commands run in process groups the job owns. Cleanup stops only those groups and keeps recovery evidence. Tests stop what they start and put deadlines on their waits.
