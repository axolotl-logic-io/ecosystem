# Task framework

This package defines the boundary between a task and its execution host. A task
receives validated task-owned inputs and explicit capabilities. It does not load
buddy configuration, discover a runtime root or receive a credential environment.

## Ownership

The host validates a versioned serializable invocation before provisioning
capabilities. It resolves trusted project policy and provisions credentials outside
the task. Credentials are never invocation fields. Each task owns its input schema,
domain decisions and domain writes. Model children remain credential-free.

The execution framework distinguishes domain outcomes (`completed`, `needs-input`,
`blocked`, `no-change`) from execution failure and cancellation. The host supplies
an execution identity and an artifact destination capability; filesystem layout is
not part of the task contract. Cancellation prevents new domain effects at checked
boundaries. Cleanup and final lifecycle reporting run even after cancellation.

The GitHub issue execution adapter owns start claims, running labels and lifecycle
comments. A claim loser produces no execution artifacts. Task retries recover from
authoritative domain state rather than treating an execution identity as a claim.
The launcher preserves one process per task. Compatibility CLIs remain supported
during the workspace migration.
