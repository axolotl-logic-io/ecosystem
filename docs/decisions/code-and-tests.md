# Code and test decisions

These decisions cover how the pipeline's own code and tests behave. The repository's code, lint and test rules are in [coding practices](../coding-practices.md).

## tests-pin-promised-behaviour

Tests pin promised behavior, not internals: reply shapes, stop codes and labels, configured limits, GitHub-visible effects and regressions. Don't assert on copied constants, prompt text, call order or whole-trace snapshots.

## commands-leave-no-processes

Commands run in process groups the job owns. Cleanup stops only those groups and keeps recovery evidence. Tests stop what they start and put deadlines on their waits.
