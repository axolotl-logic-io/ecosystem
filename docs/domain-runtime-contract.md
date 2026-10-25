# Domain runtime implementation contract

This page records the shared interfaces and ownership for the glossary-alignment refactor. Autumn accepted the plan on 2026-10-25. The latest [authority decisions](decisions/authority.md) and [buddy lifecycle decisions](decisions/buddies-and-tasks.md) govern the implementation. This is a source contract, not installed behavior.

## Domain boundaries

Tasks own sensor declarations, matching, prerequisites, actions and recovery. Buddies pair trusted scope, task responsibilities and identity. One buddy run activates every configured task loop; action runs and model sessions have separate identities. Initial execution is sequential within a buddy process, without a global stage cursor. Coordination excludes competing action effects across processes.

Use canonical task identifiers `author`, `implement`, `harden`, `sync`, `integrate`, `review-security`, `land`, `complete`, and `refactor-safely`. Developer responsibilities are Author, Implement, Harden, Sync and explicitly assigned Safe Refactor. Gatekeeper responsibilities are Integrate, Review Security, Land and Complete. Display names can retain glossary nouns in historical descriptions, but new task names use verbs.

Historical task-result v1 records remain readable as historical evidence under their original identifiers and bytes. A new v2 record carries canonical identifiers, the producing buddy run, action run and causal signal. Do not silently normalize historical records into current permission. Unknown versions, malformed authoritative records and contradictory evidence hold work.

`src/domain.ts` owns shared schemas and interfaces. It must not import runtime, signals or task implementations. Source boundaries parse with zod; do not make caller-supplied type assertions a substitute for validation.

## Shared interfaces

The task writer implements these interfaces in `src/domain.ts`. Other lanes consume them with type-only imports where possible. A necessary interface change requires a supervisor request before another lane depends on it.

```ts
type TaskId = "author" | "implement" | "harden" | "sync" | "integrate"
  | "review-security" | "land" | "complete" | "refactor-safely";
type RoleId = "developer" | "gatekeeper";
type AccessProfile = "reader" | "writer" | "lander";
type RunState = "running" | "waiting" | "stopped" | "ended";
type Verdict = "passed" | "failed" | "refused" | "unknown";
interface WorkItemRef { repo: string; number: number }
interface TargetState { branch: string; commit: string }
interface Revision { code: string; inputs: string; policy: string }
interface RunRef { id: string; previous: string | null }
type Binding = {
  workItem: WorkItemRef;
  task: TaskId;
  target: TargetState;
} & ({ requirements: string } | { revision: Revision });
interface HumanProvenance {
  route: "human";
  login: string;
  userId: number;
  organization: string;
}
type QualifiedSignal =
  | { kind: "start"; id: string; workItem: WorkItemRef; task: "implement";
      requirements: string; target: TargetState; provenance: HumanProvenance;
      recordId: number }
  | { kind: "stop"; id: string; workItem: WorkItemRef;
      provenance: HumanProvenance; recordId: number }
  | { kind: "result"; id: string; workItem: WorkItemRef; binding: Binding;
      recordId: number; producerRun: string };
interface EvidenceHold { workItem: WorkItemRef | null; reason: string }
interface SignalInbox {
  signals: readonly QualifiedSignal[];
  holds: readonly EvidenceHold[];
  complete: boolean;
}
interface ActionCause { signal: string; recordId: number }
interface TaskResult {
  binding: Binding;
  run: RunRef;
  buddyRun: string;
  verdict: Verdict;
  receipt: { summary: string; produced?: { code: string }; evidence?: unknown };
  recordId: number;
}
interface TaskView {
  workItem: WorkItemRef;
  requirements: string;
  revision: Revision | null;
  target: TargetState;
  containsTarget: boolean;
  results: readonly TaskResult[];
  hold: string | null;
}
type Readiness =
  | { state: "ready"; binding: Binding }
  | { state: "recover"; binding: Binding; reason: string }
  | { state: "waiting" | "held" | "stopped"; reason: string };
interface ActionEnd {
  state: RunState;
  outcome: "succeeded" | "failed" | "refused" | "unknown" | null;
  reason: string;
  verdict: Verdict;
  produced?: { code: string };
}
interface SessionSpec {
  agent: "issue-pipeline-author" | "issue-pipeline-developer" | "issue-pipeline-reviewer";
  model: string;
  task: string;
  schema: import("zod").ZodType;
  commits: boolean;
  phase?: "hardening" | "security-review" | "sync";
}
type SessionResult = { ok: true; reply: unknown }
  | { ok: false; transient: boolean; error: string };
interface ActionContext {
  cfg: import("./config.ts").Config;
  workItem: WorkItemRef;
  buddyRun: string;
  run: RunRef;
  cause: ActionCause;
  binding: Binding;
  checkout: { root: string; repo: string; branch: string };
  stop: AbortSignal;
  boundary: (name: string) => Promise<void>;
  op: (name: string, payload: object) => Promise<unknown>;
  session: (spec: SessionSpec) => Promise<SessionResult>;
  checkpoint: (detail: object) => Promise<void>;
}
interface TaskDefinition {
  id: TaskId;
  role: RoleId;
  access: AccessProfile;
  sensors: readonly QualifiedSignal["kind"][];
  resources: readonly ("model-session" | "test-slot" | "target-write")[];
  match: (signal: QualifiedSignal, view: TaskView) => Readiness | null;
  act: (ctx: ActionContext) => Promise<ActionEnd>;
  recover?: (ctx: ActionContext) => Promise<ActionEnd>;
}
```

The code should export schemas and types for boundary values rather than making all IDs freely interchangeable. The above shapes fix field names and module dependencies; do not implement redundant classes or pass-through layers to reproduce the diagram.

## Public component APIs

### Tasks

`src/tasks/index.ts` exports `TASKS: Readonly<Record<TaskId, TaskDefinition>>`, `readTaskView(cfg, number): Promise<TaskView>`, and the recording helpers needed by the runtime:

- `beginAction(ctx): Promise<void>` validates current prerequisites and the attempt budget, then records a new attempt with the action UUID, predecessor, buddy run and cause before the first task effect.
- `finishAction(ctx, end): Promise<void>` records the result for that attempt. An uncertain action remains unknown, not failed and eligible for repetition.
- `previousAction(cfg, binding): Promise<string | null>` reads the previous action identity. It does not authorize a retry.
- `actionCauses(cfg, number): Promise<readonly { binding: Binding; cause: ActionCause }[]>` reads all authenticated current v2 attempts. Conflicting or unreadable evidence holds. Signals use this reader to spend starts by cause independently of target movement.
- `machineSignals(cfg, number): Promise<readonly QualifiedSignal[]>` wraps only authenticated current v2 results. `readTaskView` and each task's matching own which binding is relevant. A result signal is evidence, not Land permission.

Do not repeat effectful reads merely to satisfy these signatures. Shared task recording and snapshot modules hide their own schemas, budgets and journal layout.

Author and Safe Refactor remain explicit opt-in work. A start label requests only Implement, not Author or Safe Refactor. A task with no applicable signal waits. A passed binding does not execute again. A failed, refused or unknown action is not automatically retried; report the hold. A new requirements binding requires a new accepted start. An Implement attempt on the same work item and requirements prevents another Implement attempt even if the target moves or a new start event appears. Changed revision/target bindings create new downstream work only through current qualified evidence.

Readiness `recover` is separate from new-attempt admission. The runtime calls only the task's read-only `recover` handler: never `beginAction`, `act` or `finishAction` for a new attempt. Recovery receives a new local action/invocation identity, but the task helper settles the original attempt's run and buddy run from observed original effects. Its receipt links the reconciling action. Unproven or incomplete effects hold; recovery never replays a push, rebase or Completion mutation.

Sync can act before Harden when R does not contain T. Sync's output requires fresh Harden. Complete finds the authenticated passed Land result and keeps its original R, pre-Land T and policy. It verifies current trusted inputs, own Land provenance and target ancestry without rerunning Integration or Security. A changed policy after Land does not create retroactive permission or require a new post-Land check; the irreversible Land's policy stays pinned. Contradictory landed evidence holds. No-code/no-PR completion and automatic adoption of historical/manual Lands are unsupported.

### Signals

`src/signals/inbox.ts` exports:

```ts
interface SignalScope { organization: string }
function pollSignals(cfg: Config, scope: SignalScope, buddyRun: string): Promise<SignalInbox>;
function requalify(cfg: Config, scope: SignalScope, signal: QualifiedSignal):
  Promise<{ status: "qualified" | "revoked" | "unknown"; reason: string }>;
function stopLatch(cfg: Config, number: number):
  Promise<{ state: "clear" | "latched" | "unknown"; reason: string }>;
```

Poll complete open-issue control-label listings and all event/comment pages. Discover persisted accepted signals independently of currently present labels, so removing a label does not hide accepted starts or stops. Do not create a cursor that advances past unread evidence. Retain incomplete/contradictory observations as holds.

First acceptance requires the issue label to be present and its latest application event to explain that condition. An accepted signal retains event ID, producer ID and organization. Requalification after acceptance checks retained producer identity/current membership, not label presence. A single event cannot acquire a new binding on a later poll.

Only human-produced issue labels are supported initially; PR labels, bots, configured machine-account labels and App-mediated human events grant nothing. Machine signals come from authenticated result records. Trusted requirements still require the existing allow-list and current collaborator rule; organization membership does not replace it.

Use explicit `scope.organization`, never derive it from `repo`. Verify the real membership API schemas against GitHub documentation: `/orgs/{org}/memberships/{login}` may provide `organization_url` rather than an `organization` object. Unknown reader capability or membership grants nothing. No credential changes or live activation verification is required for source delivery.

Accept/append through the existing uncertain-write journal and authoritative reread. An uncertain append is held, not posted again. Identical duplicate accepted records may be deduplicated only if all action-relevant content agrees; conflicts hold. A start is spent by an Implement v2 attempt whose cause names its ID, regardless of verdict. Any accepted stop latches the issue across buddy runs and makes all pending starts inert. Reapplying start to a binding with an attempt does not authorize a retry. No continuation operation or new control label is added.

### Buddy runtime

`src/buddy.ts` is the sole delivery runtime CLI, built as `buddy.mjs`. `src/runtime/` owns configuration, activation/admission, stop propagation, action infrastructure and local run observations. Tasks are libraries, not child stage jobs. The runtime supplies ActionContext and calls task-owned matching/actions. No permanent adapter may run legacy stage roles under new names.

Buddy config uses an explicit organization, repository config paths, one role (or a validated subset of that role's task responsibilities), and one identity with the appropriate account/model/runtime/access/network settings. Role names carry no credentials. Validate profile/account consistency and reject obsolete scheduler/assignment controls before effects.

Land authorization requires an explicit trusted `permissions.land: true` grant in the Gatekeeper buddy configuration and the same repository-scoped grant in the trusted repository configuration. Missing permission defaults to false. Both grants, configured repository scope, Land responsibility and matching landing identity must pass. The fresh ops child rereads the repository grant; the runtime rereads buddy grant, scope and identity before privileged effects. Passing Security or receiving a result signal never itself supplies permission. Ownership and all task prerequisites remain necessary.

The shared revision checking-policy digest includes repository permissions. The buddy-specific action-authorization digest records its scope, identity and grant separately; putting it in `revision.policy` would prevent Developer and Gatekeeper results from sharing a binding. Preserve that distinct authorization evidence with the Land intent. Complete and read-only Land recovery use current trusted configuration for transport fencing but retain the original Land policy as historical proof, without fresh post-Land checks.

Land's task-owned `beginAction` acquires and confirms the existing integration turn before recording the Land attempt. An unavailable turn waits with no attempt; an uncertain attempt keeps its turn. The runtime must not acquire a duplicate target-write reservation.

One buddy run UUID per activation; one new action UUID per admitted action. The action UUID is the execution invocation's `instance` and task attempt's `run.id`. The lane is stable per buddy/repo/work-item, not capacity. Every model launch names its parent action but has a separate session identity. Historical jobs are never relabeled as buddy runs.

Stop uses one scoped cooperative control. Stop admission immediately; do not kill credentialed writes, Git rebase or Land in flight on a graceful stop. Abort model-assisted work at a safe boundary; classify interrupted verification as unknown. Preserve progress, checkpoints and journals before release. A failed checkpoint keeps ownership/checkouts/reservations. Escalation remains an explicit process safety valve, not the normal domain stop.

Local observation paths:

- `runs/buddy-runs/UUID/run.json`: kind `buddy-run`, version 1; `id`, `previous`, `buddy`, `tasks`, `scope`, `accounts`, `process`, `lease`, `state`, `outcome`, `stop`, `loops`, `caps`.
- `runs/SLUG/issue-N/actions/UUID/run.json`: kind `action-run`, version 1; `id`, `previous`, `buddyRun`, `task`, `workItem`, `binding`, `cause`, `execution`, `state`, `outcome`, `stop`, `checkpoint`, `ownership`, `sessions`, `operations`, `reservations`, preserved-work paths.

These files are observations, never authority. Use explicit parent links only. Publish exact zod shapes in `docs/reference/runtime-runs.md` for the subsequent dash lane. Liveness requires both a matching fresh process observation and an unexpired lease; failure to observe liveness does not release a resource.

### Reservations

`src/runtime/reservations.ts` owns shared model-session reservation logic and consumer-aware release. It exports:

```ts
type ResourceKind = "model-session" | "test-slot" | "target-write";
interface ResourceConsumer { kind: string; id: string }
interface ReservationHandle {
  resource: ResourceKind; slot: number; holder: string;
  register: (consumer: ResourceConsumer) => Promise<void>;
  done: (consumer: ResourceConsumer) => Promise<void>;
  release: () => Promise<{ released: boolean; reason: string }>;
}
function reserveModelSession(cfg: Config, execution: InvocationBinding, cap: number):
  Promise<{ state: "reserved"; reservation: ReservationHandle }
    | { state: "waiting" | "held"; reason: string }>;
```

The runtime registers before launching and reports done only on confirmed exit. The reservation module uses authenticated shared coordination, not a PID count or local mutex. Repository/base/resource capacity is one shared policy, not independently invented per buddy. Incompatible capacity declarations hold rather than creating disjoint pools or silently oversubscribing. Unknown consumer state keeps the claim. Reuse the current target integration turn and existing consumer-aware test slots rather than creating duplicate pools. The resource writer owns the necessary coordination-schema extension and execution helper. Existing project-facing slot environment variables remain an explicit compatibility boundary.

## Ownership and integration

Every implementation lane has its own worktree, based on the shared-contract commit. Do not edit another lane's files; report required cross-seam changes. Each lane commits its handoff and reports exact validation and omissions. Parent integration resolves wiring and removes obsolete entry points after the component handoffs; it does not invent missing component behavior.

| Lane | Exclusive ownership |
| --- | --- |
| Tasks/effects | `src/domain.ts`, new `src/tasks/**`, `src/roles/**`, `src/ops.ts` canonical registration/envelope, `src/task-result*.ts`, `src/task-results.ts`, `src/ops/**`, `src/state.ts`, `src/saved-state*.ts`, `src/write-authority.ts`, `src/security-clearance.ts`, `src/land*-authorization.ts`, `src/land-provenance.ts`, `src/reviewed-target.ts`; task-specific integration tests and reference pages |
| Signals | New `src/signals/**`, `test/signals/**`, `docs/reference/signals.md`; no global Config schema edits |
| Runtime | New `src/buddy.ts`, `src/runtime/**` except `reservations.ts`, existing `src/job/**`, `src/config.ts`, `src/config-schema.ts`, `src/config-legacy.ts`, `src/config-renamed.ts`; runtime integration tests and `docs/reference/runtime-runs.md`; no task/result/ops edits |
| Resources | `src/runtime/reservations.ts`, coordination resource-schema/record support, `src/execution.ts` resource helper and removal of assignment-grant check, `src/lane-slot*.ts`, resource integration tests |
| Parent/integration | Build/install/package manifests; removal of obsolete stage/scheduler/assignment/launcher entry points, final shared import wiring, examples and root/current documentation; dashboard scheduled after observation schema handoff |

Temporary compilation failures caused by not-yet-integrated adjacent lanes must be reported honestly. Do not weaken guards, lint rules or types to make an isolated lane appear green. Focused real-file/subprocess/Git tests should prove each lane's own boundary. No unit-test restoration or blanket fixture restoration. Reuse another lane's committed test kit when available; do not create parallel copies of the same fake infrastructure.
