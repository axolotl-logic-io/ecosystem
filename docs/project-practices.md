# Project practices

These are this repository's own rules. They add to the shared [coding practices](coding-practices.md), which every repository keeps an identical copy of.

## Types

External data parsed at the boundary includes CLI arguments, environment variables, config and state files, GitHub responses and model tool inputs.

## Lint

The root and pipeline Biome configs encode the lint policy and its documented process-boundary exceptions.

## Tests

The issue pipeline's tests don't yet follow the folder layout that `test-code-in-test` requires; a planned reorganization will fix that. The [pipeline README](../apps/issue-pipeline/README.md#tests) describes its isolated test setup.
