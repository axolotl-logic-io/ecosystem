# Runtime runs

The buddy runtime is the `buddy.mjs` CLI, built from `apps/issue-pipeline/src/buddy.ts`. One activation of a buddy is a *buddy run*. Each action that the run admits is an *action run*. This page gives the buddy configuration file, the runtime's identities, how a stop works, and the exact shape of the two local observation files. This is a source contract; nothing here runs until the pipeline is installed.

## Buddy configuration

A buddy file is strict JSON. The runtime refuses unknown keys. The file and every repository config that it names must be regular files, not links, owned by the current user and writable by nobody else.

```json
{
  "version": 1,
  "name": "lawd",
  "scope": {
    "organization": "ORGANIZATION",
    "repositories": ["/absolute/path/to/repository-config.json"]
  },
  "role": "gatekeeper",
  "identity": {
    "name": "lawd",
    "account": { "provider": "github", "login": "LANDING_ACCOUNT" },
    "profiles": ["reader", "lander"]
  },
  "permissions": { "land": true }
}
```

- `ORGANIZATION` is the GitHub organization whose members' signals count. The runtime never derives it from a repository name.
- `role` is `developer` or `gatekeeper`. A buddy runs every task of its role except Safe Refactor, which runs only when `responsibilities` lists it.
- `responsibilities` is optional. It narrows the buddy to a subset of its role's tasks.
- `identity.profiles` must equal exactly the access profiles that its tasks need: `reader`, `writer` or `lander`.
- `identity.account.login` must be the repository config's `devAccount` for a Developer, or its `landingAccount` for a Gatekeeper.
- `identity.models` is optional. It may override the repository config's `author`, `developer` or `reviewer` model.
- `pollSeconds` (5 to 3600, default 60), `stopPollSeconds` (1 to 600, default 15) and `leaseSeconds` (30 to 3600, default 300) are optional.

The runtime refuses the obsolete scheduler and assignment controls `assignments`, `grant`, `grantor`, `maxJobs`, `stageCaps`, `orchestratorIntervalSeconds`, `takeNewWork`, `stage` and `stages`. It also refuses a buddy-level `modelSessions` or `resources`. Capacity is the repository's shared `resources.modelSessions` pool, which every repository config must supply; see [project settings](project-settings.md).

### Land permission

A Gatekeeper may Land only when both its buddy file and the repository config set `permissions.land: true`. Missing means false. The buddy must also hold the `land` responsibility, the `lander` profile and the landing account. Passing checks or receiving a result signal never grants Land.

### Authorization digest

Each buddy and repository pair has an *authorization digest*: a SHA-256 over the buddy file's effective settings and the repository's config path, `repo`, base branch, both accounts and Land permission. The digest belongs to the action. It is recorded in the action run and in Land-attempt evidence, and is never part of the shared checking policy (`cfg.policyBinding`).

Every ops request of a buddy action carries this envelope, after the payload fields, so that a payload can't override it:

```json
{ "buddy": { "config": "BUDDY_FILE", "run": "BUDDY_RUN_ID", "task": "TASK_ID", "authorizationDigest": "DIGEST" } }
```

The ops child calls `bindBuddyAuthorization(cfg, repositoryConfigPath, envelope)` from `src/runtime/buddy-config.ts`. It rereads the trusted buddy file, then checks the repository scope, the task responsibility, the role's account, the digest and, for Land, both permissions. It returns a config with an internal `buddyAuthorization` field. `assertBuddyAuthorization(cfg)` rereads all of it again at each privileged effect.

## Run the buddy

To check a buddy file without any effect, run:

```sh
node buddy.mjs --config BUDDY_FILE --check
```

It prints one JSON object with the buddy, its tasks and, per repository, the shared model-session cap and authorization digest.

To start a buddy run, run:

```sh
node buddy.mjs --config BUDDY_FILE
```

The run polls each repository's qualified signals, offers each signal to every task loop that senses its kind, and runs one admitted action at a time. It has no stage cursor. When the trusted configuration changes or can't be read, the run stops; restart it to run under the new configuration. On exit it prints `{"buddyRun": ID, "kind": "stopped" | "failed", "reason": TEXT}`. It exits 0 for a stop and 1 for a failure or a refused configuration.

## Identities

- A buddy run has a new UUID for each activation.
- An action run has a new UUID for each admitted action. The same UUID is the execution invocation's `instance` and the task attempt's `run.id`.
- A model session has its own UUID. Its `parent` names its action run.
- The execution lane is stable for a buddy, repository and work item: `buddy:NAME:OWNER/REPO:NUMBER`. It is not a capacity slot.

## Admission

An action starts only when all of these pass, freshly and in order:

1. Neither the work item nor the whole run is stopping.
2. `bindBuddyAuthorization` accepts the action's envelope.
3. The work item's stop latch reads clear.
4. The causal signal still qualifies.
5. The action wins fenced issue execution under its new UUID.
6. The repository's shared pool grants a model-session slot at the trusted cap, when the task uses model sessions.

A lost race or a full pool waits. Anything unreadable holds. A `recover` readiness runs only the task's read-only recovery: it never begins a new attempt. The runtime doesn't reserve the target's integration turn; Land's own `beginAction` takes it.

## Stop

One cooperative stop applies to the whole run (SIGTERM or SIGINT) or to one work item (an accepted stop signal). A stop for one work item never stops another.

- No new action, model session or op starts in the stop's scope.
- Live model sessions get an abort request at their next safe point.
- Nothing is killed. A credentialed write, Git rebase or Land already in flight runs to its end.
- Checkpoints, the result record and the checkout's preservation still run.
- An action that the stop interrupted ends with state `stopped` and outcome `unknown`.

The runtime handles a signal at its next asynchronous step, so a stop that arrives during a GitHub read takes effect once that read returns. A second signal only prints that the run is already stopping. SIGKILL stays the operator's explicit escalation.

After the task ends, the action preserves its checkout's uncommitted work as patches and its local commits as recovery bundles, then removes the checkout. It keeps the checkout whole when a rebase is in progress or preservation fails. It keeps issue execution when the result record, a checkpoint, a journaled write, a stop recovery or a lane-slot consumer is unresolved. It keeps the model-session reservation too when a checkpoint is uncertain.

## Observation files

Both files live under the pipeline root (`$ISSUE_PIPELINE_ROOT`, by default `~/.pi/agent/issue-pipeline`). Each file is rewritten whole and atomically on every change. They are observations, never authority: nothing reads them to decide an effect. They link to each other only through `previous`, `buddyRun` and session `parent`.

A buddy run is live only when its process observation is fresh and matches a running process, and its lease hasn't expired. Failing to observe liveness never releases a resource.

### Buddy run

Path: `runs/buddy-runs/BUDDY_RUN_ID/run.json`.

```ts
const TIME = z.iso.datetime();
const UUID = z.uuid();
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const STOP = z.strictObject({
  scope: z.enum(["buddy", "work-item"]),
  reason: z.string().min(1),
  requestedAt: TIME,
});

const BUDDY_RUN = z.strictObject({
  kind: z.literal("buddy-run"),
  version: z.literal(1),
  id: UUID,
  previous: UUID.nullable(),
  buddy: z.strictObject({
    name: z.string().min(1),
    role: z.enum(["developer", "gatekeeper"]),
    identity: z.string().min(1),
    config: z.string().min(1),
  }),
  tasks: z.array(TASK_ID),
  scope: z.strictObject({
    organization: z.string().min(1),
    repositories: z.array(
      z.strictObject({
        config: z.string().min(1),
        repo: z.string().min(1),
        base: z.string().min(1),
        authorization: SHA256,
      }),
    ),
  }),
  accounts: z.array(
    z.strictObject({ provider: z.literal("github"), login: z.string() }),
  ),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
    startedAt: TIME,
    observedAt: TIME,
  }),
  lease: z.strictObject({ seconds: z.int().positive(), expiresAt: TIME }),
  state: RUN_STATE, // "running" | "waiting" | "stopped" | "ended"
  outcome: z
    .strictObject({
      kind: z.enum(["stopped", "failed"]),
      reason: z.string().min(1),
      at: TIME,
    })
    .nullable(),
  stop: STOP.nullable(),
  loops: z.array(
    z.strictObject({
      task: TASK_ID,
      repo: z.string().min(1),
      state: z.enum(["idle", "acting", "waiting", "held", "stopped"]),
      reason: z.string().nullable(),
      polledAt: TIME.nullable(),
      action: UUID.nullable(),
    }),
  ),
  caps: z.array(
    z.strictObject({
      repo: z.string().min(1),
      modelSessions: z.int().positive(),
      testSlots: z.int().positive().nullable(),
    }),
  ),
});
```

`previous` is the latest earlier run of the same buddy name. `loops` has one entry for each task and repository. `caps.testSlots` is the repository's `laneSlots`, or null.

### Action run

Path: `runs/SLUG/issue-N/actions/ACTION_RUN_ID/run.json`, where `SLUG` is the repository with `/` replaced by `__`.

```ts
const ACTION_RUN = z.strictObject({
  kind: z.literal("action-run"),
  version: z.literal(1),
  id: UUID,
  previous: UUID.nullable(),
  buddyRun: UUID,
  task: TASK_ID,
  workItem: WORK_ITEM_REF,
  binding: BINDING,
  cause: ACTION_CAUSE,
  execution: INVOCATION_BINDING,
  mode: z.enum(["act", "recover"]),
  authorization: SHA256,
  state: RUN_STATE,
  outcome: z.enum(["succeeded", "failed", "refused", "unknown"]).nullable(),
  verdict: VERDICT.nullable(),
  reason: z.string().nullable(),
  stop: STOP.nullable(),
  checkpoint: z.strictObject({
    state: z.enum(["none", "saved", "uncertain"]),
    at: TIME.nullable(),
    reason: z.string().nullable(),
  }),
  ownership: z.strictObject({
    state: z.enum(["held", "released", "retained"]),
    reason: z.string().nullable(),
  }),
  sessions: z.array(
    z.strictObject({
      id: UUID,
      parent: UUID,
      key: z.string().min(1),
      agent: z.string().min(1),
      model: z.string().min(1),
      phase: z.string().nullable(),
      commits: z.boolean(),
      pid: z.int().nullable(),
      reservation: z.strictObject({ slot: z.int().positive() }).nullable(),
      startedAt: TIME,
      endedAt: TIME.nullable(),
      outcome: z.enum(["ok", "failed"]).nullable(),
    }),
  ),
  operations: z.array(
    z.strictObject({
      key: z.string().min(1),
      op: z.string().min(1),
      pid: z.int().nullable(),
      startedAt: TIME,
      endedAt: TIME.nullable(),
      outcome: z.enum(["ok", "failed"]).nullable(),
    }),
  ),
  reservations: z.array(
    z.strictObject({
      resource: z.enum(["model-session", "test-slot", "target-write"]),
      slot: z.int().positive(),
      state: z.enum(["held", "released"]),
      reason: z.string().nullable(),
    }),
  ),
  preserved: z.strictObject({
    checkout: z.string().nullable(),
    patches: z.array(z.string()),
  }),
});
```

`TASK_ID`, `WORK_ITEM_REF`, `BINDING`, `ACTION_CAUSE`, `RUN_STATE` and `VERDICT` come from `src/domain.ts`; `INVOCATION_BINDING` comes from `src/coordination-record-schema.ts`. `previous` is the task's previous action on the same binding. `mode` is `recover` for a read-only recovery, which records no attempt of its own. `authorization` is the action's authorization digest. `preserved.checkout` names a checkout kept whole, and `preserved.patches` names the saved patches of uncommitted work, relative to the issue's run folder. The same folder holds each session's JSONL (`sessions/KEY.jsonl`), `context.jsonl` and the control socket.

Both schemas are exported as `BUDDY_RUN` and `ACTION_RUN` from `src/runtime/observations.ts`.
