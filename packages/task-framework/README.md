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
The launcher runs one process per task.

## Public contract

Import `TaskDefinition`, `DomainOutcome`, `ExecutionContext`, `ExecutionHost`,
`ExecutionResult`, `Invocation`, `parseInvocation` and `executeTask` from
`@ecosystem/task-framework`. Importing this package starts no CLI or process.

`TaskDefinition<Inputs, Capabilities, Result>` declares an `id`, a Zod `inputs`
schema and an asynchronous `run(inputs, capabilities, context)` function. The
result is `{ status, result }`, where `status` is one of the four domain outcomes.
A blocked prerequisite is a domain result; throwing means execution failed.

An invocation is a strict JSON object:

```json
{
  "version": 1,
  "task": "sample",
  "execution": "host-generated-attempt-id",
  "inputs": { "message": "task-owned data" }
}
```

`parseInvocation(value, task)` validates both the envelope and the task's input
schema, and rejects a mismatched task id. It returns the parsed envelope and
inputs. Hosts can use it before provisioning resources or starting a child.

`executeTask(task, value, provision, host)` validates again, checks cancellation,
provisions capabilities from parsed inputs, checks cancellation again and runs the
task. The context supplies the execution id, an `AbortSignal`, `checkCancelled()`
and `artifacts.publish(name, content)`. Artifact names are logical names; the host
chooses their destination. Execution ids identify attempts, not issue ownership or
domain idempotency. Task contracts must define their own retry identities.

The returned execution result is one of:

- `{ status: "finished", outcome }`, including blocked and needs-input outcomes.
- `{ status: "failed", error }`, including validation and finalization failures.
- `{ status: "cancelled", reason }`, when the host signal was aborted.

The host supplies `signal`, `artifacts`, `cleanup()` and `report(result)`. Cleanup
runs once before reporting on every path, including invalid input, provisioning
failure and cancellation. A cleanup failure is reported as failure. A reporting
failure is returned as failure; reporting is not retried implicitly. The host must
make reporting idempotent where retries are needed. Finalization does not use the
aborted signal.

Cancellation is cooperative. Tasks check `checkCancelled()` before effects and at
long-running boundaries; provisioned capabilities must enforce their own stop and
authority guards. Abort does not roll back completed effects. Retained checkouts
and other recoverable work remain the capability provider's responsibility.

## Issue adapter

`apps/issue-host/src/task-app/issue-execution.ts` owns the claimed-run
lifecycle. Its claim, stop, recovery and artifact services live in
[`task-runtime`](../task-runtime/README.md). The entry point in `task-app.ts`
reads the launcher's invocation and credentials and arbitrates the claim before
invoking that adapter. The adapter hands each task bootstrap a `TaskRun` that
carries the repository config path and the buddy's Git transport. Each bootstrap
loads the config, builds its task's inputs and capabilities and runs the task
definition through `executeTask`. This package imports no application code.
[#294](https://github.com/axolotl-logic-io/ecosystem/issues/294) moves the
lifecycle onto `ExecutionHost` and removes `TaskRun`.
