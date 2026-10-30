# Runtime runs

The buddy runtime is the `buddy.mjs` CLI, built from `apps/issue-pipeline/src/buddy.ts`. A version 2 buddy file makes the buddy a [launcher of task apps](#launcher-buddies). A version 1 file runs the earlier runtime, which #254 removes: one activation of such a buddy is a *buddy run*, and each action that the run admits is an *action run*. This page gives both buddy files, the earlier runtime's identities, how a stop works, the exact shape of the local observation files and how task apps run. This is a source contract; nothing here runs until the pipeline is installed.

## Launcher buddies

A launcher buddy watches the repositories in its scope for start labels of its tasks and runs the matching task app for each start it sees. The [task app](#task-app-runs) claims the start, does the work and reports. The buddy does nothing else.

### Launcher buddy file

A launcher buddy file is strict JSON. The buddy refuses unknown keys. The file and every repository config that it names must be regular files, not links, owned by the current user and writable by nobody else.

```json
{
  "version": 2,
  "name": "hippy",
  "scope": { "repositories": ["/absolute/path/to/repository-config.json"] },
  "tasks": ["gherkin", "implement", "fix"],
  "account": {
    "login": "ACCOUNT",
    "credentials": { "file": "/absolute/path/to/credentials.env", "variable": "VARIABLE" }
  }
}
```

- `name` names the buddy in its log.
- `scope.repositories` lists absolute paths of repository configs. The buddy reads only each config's `repo` and `baseBranch`, which defaults to `main`. Two configs can't name one repository.
- `tasks` lists the tasks whose start labels the buddy launches: `gherkin`, `implement`, `verify`, `fix` or `land`, each at most once.
- `ACCOUNT` is the buddy's GitHub account. The buddy and its task apps make every GitHub write through it.
- `credentials.file` is the absolute path of the operator's private credential file, which only its owner can read. `VARIABLE` is the entry in it that holds `ACCOUNT`'s token. The file is parsed as dotenv text and never exported.
- `pollSeconds` is optional: the pause between polls, 1 to 3600 seconds, default 60.
- `claimWaitsMs` is optional and read only by task apps. It lists up to 10 pauses, each 0 to 60000 milliseconds, between rereads of the issue timeline while it doesn't yet show the app's removal of a start label. The default is `[500, 1000, 2000, 4000]`.

Each buddy needs its own GitHub account, so that the account that claims a start identifies the buddy. Keep a machine's buddy files in one folder. A buddy refuses to start when another JSON file in that folder is a buddy file, of either version, that names the same account, compared without case. Buddies on other machines are out of its sight.

### Run a launcher buddy

To check a launcher buddy file without contacting GitHub, run:

```sh
node "$ISSUE_PIPELINE_ROOT/buddy.mjs" --config BUDDY_FILE --check
```

It prints one JSON object with the buddy's name, account, tasks, repositories and the program of each task's app. It refuses the file, and exits 1, for every reason the buddy would refuse to start except an unverified credential.

To start the buddy, omit `--check`. Before any other effect, it checks the file and its repository configs, refuses an account that another buddy file in its folder names and refuses a task whose app isn't installed at `$ISSUE_PIPELINE_ROOT/TASK.mjs`. It then reads the token and checks with GitHub that it is the account's.

Each poll lists, for each repository and task, the open issues with `start:TASK`. Pull requests are skipped. For each issue, the buddy runs:

```sh
node "$ISSUE_PIPELINE_ROOT/TASK.mjs" --config BUDDY_FILE --issue OWNER/REPO#N
```

The buddy checks nothing else first: not `agent:TASK:running`, earlier results nor `agents:stop`. The app's claim decides which buddy runs a start, and the app holds while `agents:stop` is on the issue. So the buddy runs every start it sees, two runs of one task on one issue can overlap, and an app launched for a start that another app already took ends quietly. An app that fails doesn't stop the buddy, which leaves the reporting to the app.

SIGTERM or SIGINT ends the polling. The buddy then waits for the apps it launched to end, prints `{"buddy": NAME, "kind": "stopped", "reason": TEXT}` and exits 0. It doesn't signal its apps, though a terminal's Ctrl-C reaches every process in its group. To end their runs too, apply `agents:stop` to their issues, or signal the apps. A refused configuration or an unverified credential exits 1 with the reason on stderr.

### Launcher log

The buddy writes one JSON line to stderr for each app that ends:

```json
{"at": "TIME", "buddy": "NAME", "task": "TASK", "issue": "OWNER/REPO#N", "pid": 123, "exit": 0, "signal": null}
```

`exit` is the app's exit status, or null when a signal ended it, and `signal` names that signal. An app that couldn't start has an `error` instead of `pid`, `exit` and `signal`. A listing the buddy can't read writes a line with its `repo`, `task`, `"state": "warning"` and a `reason`; the next poll tries again. The apps' own output joins the buddy's stderr, so that its stdout holds only its final line.

## Buddy configuration

This section describes the earlier runtime's version 1 buddy file, as do the sections up to [task app runs](#task-app-runs).

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
- `pollSeconds` (1 to 3600, default 60), `stopPollSeconds` (1 to 600, default 15) and `leaseSeconds` (30 to 3600, default 300) are optional.

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
5. For a new Implement or Fix attempt, no person is assigned to the issue.
6. The action wins fenced issue execution under its new UUID.
7. The repository's shared pool grants a model-session slot at the trusted cap, when the task uses model sessions.

A lost race, a full pool or an issue assigned to a person waits. Anything unreadable holds. See [issue assignment](coordination.md#issue-assignment). A `recover` readiness runs only the task's read-only recovery: it never begins a new attempt. The runtime doesn't reserve the target's integration turn; Land's own `beginAction` takes it.

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

## Task app runs

A task app is one task's command-line program, built on the task app framework in `apps/issue-pipeline/src/task-app/`. A [launcher buddy](#launcher-buddies) runs it for each start label it sees, and an operator can run one by hand. Implement runs as `implement.mjs`; see [Implement](#implement). Verify's app is `verify.mjs`; see [the Verify task app](review.md#verify-task-app). Fix's app is `fix.mjs`; see [Fix](review.md#fix). The [domain runtime contract](../domain-runtime-contract.md) describes the model it builds.

To run a task app, run:

```bash
node TASK_APP --config BUDDY_FILE --issue OWNER/REPO#N
```

- `TASK_APP` is the task app's program.
- `BUDDY_FILE` is an absolute path to a [launcher buddy file](#launcher-buddy-file). The app acts as its `account.login`.
- `OWNER/REPO#N` is the issue. The buddy's scope must name a repository config for `OWNER/REPO`.

The app reads the token that the buddy file's `account.credentials` entry selects, and checks with GitHub that the token is the account's before any other call. It doesn't check that the buddy file lists its task.

The app exits 0 when its run ends normally: it finished its work, lost the claim, found `agents:stop` before claiming, or stopped on it. It exits 1 when the run failed or it couldn't confirm its claim.

### Claim confirmation

GitHub removes a label only while it's on the issue. When GitHub accepts the app's removal of `start:X`, the app took a start that no other buddy took. The app then reads the timeline until it shows its own `unlabeled` event for `start:X` after the latest `labeled` event it noted before the removal. That event is the run's claim.

If another buddy removed the label first and a person applied it again before this app's removal, the app took the newer start, and it runs it.

### Running label

Each run that wins its claim ends by posting an end comment with a hidden marker that names its claim. It then removes `agent:X:running` only when every claim of `X` on the timeline has an end comment from the account that made it. Afterwards it reads the timeline again, and adds the label back if a new claim appeared while it was removing it.

A crashed run posts no end comment, so its claim holds the label. To release it, a person removes `agent:X:running`. The app counts every claim before that removal as ended. It tells a person's removal from a run's by the actor: a run's account has posted an end comment for `X`, and a person's hasn't. A person who removes `start:X` by hand makes a claim that no run ends, which holds the label the same way.

### Task run

Path: `runs/SLUG/issue-N/task-runs/TASK_RUN_ID/run.json`. Only a run that won its claim writes one.

```ts
const TASK_RUN = z.strictObject({
  kind: z.literal("task-run"),
  version: z.literal(1),
  id: z.uuid(),
  task: z.string().regex(TASK_ID),
  workItem: z.strictObject({
    repo: z.string().regex(REPOSITORY),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  claim: z.strictObject({
    start: z.number().int().positive().nullable(),
    removal: z.number().int().positive(),
  }),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
  }),
  state: z.enum(["running", "ended"]),
  step: z.enum(["mark", "work", "unmark"]),
  outcome: z.enum(["succeeded", "failed", "stopped"]).nullable(),
  reason: z.string().nullable(),
  startedAt: TIME,
  endedAt: TIME.nullable(),
});
```

A task app's model sessions write their JSONL files to `sessions/` in the same folder.

`claim.start` is the `labeled` event of the start the run took, or null when the timeline doesn't show one, and `claim.removal` is its claim's `unlabeled` event. `step` is the lifecycle step the run is in. `reason` names the error of a failed run. The schema is exported as `TASK_RUN` from `src/task-app/run-record.ts`.

The [workflow dashboard](../../apps/workflow-dash/README.md) shows each task run as an action. It shows a run recorded as running whose process is gone, or doesn't run on this host, as unavailable.

### Implement

`implement.mjs` runs Implement when a person applies `start:implement`. It writes the change the issue asks for on the branch `agent/issue-N`, hardens it in a fresh session and marks the issue's pull request (PR) ready for review. It doesn't wait for an assignee, an Author result or an earlier start, and it continues earlier work from GitHub alone:

1. It refuses unless the buddy's account is the repository config's `devAccount`, which pushes the code. It also refuses when the issue's PR from `agent/issue-N` is merged or closed. A person reopens a closed PR to continue on it.
2. It clones the repository into a checkout of its own under `runs/SLUG/issue-N/`. The checkout starts from the branch's head when the branch exists, and from the base branch otherwise. It runs the repository's setup there.
3. It pushes the branch, with an empty `Start work on #N` commit when the branch has nothing ahead of the base. It then opens a draft PR with `Closes #N`, or moves the existing open PR back to draft.
4. It writes `issue.md` in the task run's folder. The file holds the issue's title and body, the latest Gherkin, the issue's comments and, when the PR exists, its reviews, review threads and conversation. The latest Gherkin is the newest marked comment from an account that claimed `start:gherkin`. Comments, reviews and threads show only when a collaborator wrote them. The file counts the ones it leaves out.
5. It runs a Developer session, then a fresh hardening session that doesn't see the first one's conversation. Each session commits through `pipeline_commit`, and each commit is pushed as it's made. When the branch already held work, the writing session is told to continue it.
6. It marks the PR ready and posts a result comment that names the PR and its head.

A push never overwrites the branch. If the branch holds commits that the checkout lacks, the run pushes its work to `agent/issue-N-recovery-ID` instead and fails. While `agents:stop` is on the issue, a session's commits stay in the checkout and the run stops. When the checkout closes, it bundles any commits that GitHub still lacks into the issue's run folder.

Implement doesn't support a repository that sets `commands.teardown`. It reserves no model-session capacity, and it doesn't use the older Implement task's checkpoints or `recover-implement.mjs`.
