# Domain runtime implementation contract

This page records the shared interfaces and ownership for the glossary-alignment refactor. It follows the five delivery tasks that replaced the separate-duties tasks. This is a source contract, not installed behavior.

## Domain boundaries

Tasks own sensor declarations, matching, prerequisites, actions and recovery. Buddies pair trusted scope, task responsibilities and identity. One buddy run activates every configured task loop; action runs and model sessions have separate identities. Initial execution is sequential within a buddy process, without a global stage cursor. Coordination excludes competing action effects across processes.

Use canonical task identifiers `author`, `implement`, `verify`, `fix`, `land` and `refactor-safely`. Each task definition names its role and access profile, and buddy configuration derives from them:

| Task | Role | Access | Binds |
| --- | --- | --- | --- |
| `author` | Developer | writer | Requirements |
| `implement` | Developer | writer | Requirements |
| `verify` | Gatekeeper | reader | The PR head revision |
| `fix` | Developer | writer | The PR head revision |
| `land` | Gatekeeper | lander | The PR head revision |
| `refactor-safely` | Developer | writer | A revision |

A Developer buddy's default responsibilities are Author, Implement and Fix; Safe Refactor is explicitly assigned. A Gatekeeper's are Verify and Land. The tasks `harden`, `sync`, `integrate`, `review-security` and `complete` are removed: hardening is part of Implement, Sync and Integrate fold into Fix and Verify, Security is part of Verify, and Complete is part of Land. Display names can retain glossary nouns in historical descriptions, but new task names use verbs.

A task-result v2 record carries canonical identifiers, the producing buddy run, action run and causal signal. Readers accept only v2. A record of any other version, including a v1 record from an earlier release, a malformed authoritative record and contradictory evidence hold work.

`src/domain.ts` owns shared schemas and interfaces. It must not import runtime, signals or task implementations. Source boundaries parse with zod; do not make caller-supplied type assertions a substitute for validation.

## Shared interfaces

The task writer implements these interfaces in `src/domain.ts`. Other lanes consume them with type-only imports where possible. A necessary interface change requires a supervisor request before another lane depends on it.

```ts
type TaskId = "author" | "implement" | "verify" | "fix" | "land"
  | "refactor-safely";
// REQUIREMENTS_TASKS bind requirements; REVISION_TASKS bind a revision.
type RequirementsTask = "author" | "implement";
type RevisionTask = "verify" | "fix" | "land" | "refactor-safely";
type StartTask = "author" | "implement" | "verify";   // START_TASKS
const VERIFY_FIX_ROUNDS = 3;
type RoleId = "developer" | "gatekeeper";
type AccessProfile = "reader" | "writer" | "lander";
type RunState = "running" | "waiting" | "stopped" | "ended";
type Verdict = "passed" | "failed" | "refused" | "unknown";
interface WorkItemRef { repo: string; number: number }
interface TargetState { branch: string; commit: string }
interface Revision { code: string; inputs: string; policy: string }
interface RunRef { id: string; previous: string | null }
type Binding =
  | { workItem: WorkItemRef; task: RequirementsTask; target: TargetState;
      requirements: string }
  | { workItem: WorkItemRef; task: RevisionTask; target: TargetState;
      revision: Revision };
interface HumanProvenance {
  route: "human";
  login: string;
  userId: number;
  organization: string;
}
type ReviewState = "APPROVED" | "CHANGES_REQUESTED";
// One submitted PR review, bound to the head commit it was submitted against.
interface PrReview { id: number; pr: number; commit: string; state: ReviewState }
type QualifiedSignal =
  | { kind: "start"; id: string; workItem: WorkItemRef;
      task: "author" | "implement"; requirements: string; target: TargetState;
      provenance: HumanProvenance; recordId: number }
  | { kind: "start"; id: string; workItem: WorkItemRef; task: "verify";
      pr: number; head: string; target: TargetState;
      provenance: HumanProvenance; recordId: number }
  | { kind: "review"; id: string; workItem: WorkItemRef; review: PrReview;
      provenance: HumanProvenance; recordId: number }
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
// receipt.evidence of a determined Verify result. Its verdict mirrors the
// review: passed for APPROVED, refused for CHANGES_REQUESTED.
interface VerifyEvidence {
  review: PrReview; blocking: number; nits: number; security: boolean;
}
// receipt.evidence of a determined Land result.
type LandEvidence =
  | { outcome: "merged"; pr: number; head: string; mergeCommit: string;
      issueClosed: true }                       // passed; produced = mergeCommit
  | { outcome: "conflict"; pr: number; head: string; base: TargetState;
      reason: string };                         // refused; for a started Fix
interface TaskResult {
  binding: Binding;
  run: RunRef;
  buddyRun: string;
  cause: ActionCause;
  verdict: Verdict;
  receipt: { summary: string; produced?: { code: string }; evidence?: unknown };
  recordId: number;
}
interface TaskView {
  permissions: { land: boolean };
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
  phase?: "hardening" | "security-review" | "fix";
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
  prepare: () => Promise<void>;
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

A start label requests only its own task: `start:author` Author, `start:implement` Implement, `start:verify` Verify, `start:fix` Fix and `start:land` Land. A start label is the only thing that requests a task; no result or review does. Safe Refactor has no pipeline action and no start label. Implement doesn't wait for an unsettled Author. A task with no applicable signal waits. A passed binding does not execute again. A failed, refused or unknown action is not automatically retried; report the hold. The one exception is an Implement run lost before it settled: read-only recovery settles it as interrupted, and while its requirements are still current, a person's new `start:implement` continues it from the pushed branch ([interrupted Implement runs](reference/task-results.md#interrupted-implement-runs)). A `start:verify`, `start:fix` or `start:land` requests its task on the PR's head when the task runs; a push after acceptance doesn't make it stale. A new one for the same head is the one explicit retry: it requests a new attempt of a failed run, within the binding's attempt budget. A new requirements binding requires a new accepted start. Apart from that continuation, an Implement attempt on the same work item and requirements prevents another Implement attempt even if the target moves or a new start event appears. Changed revision/target bindings create new downstream work only through current qualified evidence.

Readiness `recover` is separate from new-attempt admission. The runtime calls only the task's read-only `recover` handler: never `beginAction`, `act` or `finishAction` for a new attempt. Recovery receives a new local action/invocation identity, but the task helper settles the original attempt's run and buddy run from observed original effects. Its receipt links the reconciling action. Unproven or incomplete effects hold; recovery never replays a push, merge, review submission or issue close.

The review loop runs on results and human reviews:

- Implement records its result only after a fresh hardening session.
- Verify becomes ready only for `start:verify` naming the current PR head. It runs `commands.test`, the head's required CI and the Security review, and submits one review through the landing account against the head's commit. Only nits approve; a Security finding always blocks.
- Fix becomes ready for a refused Verify on the current head, a qualified person's `CHANGES_REQUESTED` review on it, or a refused Land that found a conflict. It merges the base into the head, answers every blocking comment with code and a thread reply, pushes through the development account and marks a draft PR ready. Only the landing account's requests for changes and a currently qualified person's direct it; anyone else's are neither given to its session nor answered.
- `verifyFixRounds(view)` in `tasks/chain.ts` counts the Fix results whose `cause.signal` is `result:N` for a refused Verify result `N`. At `VERIFY_FIX_ROUNDS` such rounds, a further request for changes holds the item for a person. Fix rounds that a person or Land caused don't count.
- Land needs a passed Verify of the current head, whose Security review must pass before any merge, an approval on that head from the landing account or a qualified person, no standing request for changes, a head that contains the base, green required CI and `permissions.land`. It merges with `gh pr merge --merge --match-head-commit`, then closes the issue; one result covers both. On a conflict it marks the PR a draft and records a refused result. Its recovery reads the PR's merged state and the issue's state, closes an issue a merged PR left open, and never merges or closes twice.

Only an unsettled or passed Land fences code writes (`src/write-authority.ts`). A Land refused for a conflict leaves code writable for Fix. Automatic adoption of historical or manual merges is unsupported.

### Signals

`src/signals/inbox.ts` exports:

```ts
interface SignalScope { organization: string }
function pollSignals(cfg: Config, scope: SignalScope, buddyRun: string): Promise<SignalInbox>;
function requalify(cfg: Config, scope: SignalScope, signal: QualifiedSignal):
  Promise<{ status: "qualified" | "revoked" | "unknown"; reason: string }>;
function stopLatch(cfg: Config, number: number):
  Promise<{ state: "clear" | "latched" | "unknown"; reason: string }>;
function requalifyHumanNow(cfg: Config, scope: SignalScope,
  source: { id: string; recordId: number; workItem: WorkItemRef }):
  { status: "qualified" | "revoked" | "unknown"; reason: string };
function stopLatchNow(cfg: Config, number: number):
  { state: "clear" | "latched" | "unknown"; reason: string };
```

The synchronous primitives share the public async APIs' exact source parsing and qualification rules. They exist for synchronous ops mutation guards, not a second signal policy. Human effect checks reread the authenticated accepted record, not caller-supplied provenance. Machine effect checks use the task lane's synchronous checked ledger and configured producer identity.

Poll complete open-issue control-label listings and all event/comment pages. Discover persisted accepted signals independently of currently present labels, so removing a label does not hide accepted starts or stops. Do not create a cursor that advances past unread evidence. Retain incomplete/contradictory observations as holds.

First acceptance requires the issue label to be present and its latest application event to explain that condition. An accepted signal retains event ID, producer ID and organization. Requalification after acceptance checks retained producer identity/current membership, not label presence. A single event cannot acquire a new binding on a later poll.

Human signals are issue labels and a qualified person's submitted review on the issue's linked PR. A review signal binds the head commit it was submitted against; the landing account's reviews are Verify results, never review signals. PR labels, bots, configured machine-account labels and App-mediated human events grant nothing. Machine signals come from authenticated result records. Trusted requirements still require the existing allow-list and current collaborator rule; organization membership does not replace it.

Use explicit `scope.organization`, never derive it from `repo`. Verify the real membership API schemas against GitHub documentation: `/orgs/{org}/memberships/{login}` may provide `organization_url` rather than an `organization` object. Unknown reader capability or membership grants nothing. No credential changes or live activation verification is required for source delivery.

Accept/append through the existing uncertain-write journal and authoritative reread. An uncertain append is held, not posted again. Identical duplicate accepted records may be deduplicated only if all action-relevant content agrees; conflicts hold. A start is spent by a v2 attempt of its task whose cause names its ID, regardless of verdict. Any accepted stop latches the issue across buddy runs and makes all pending starts inert. Reapplying start to a binding with an attempt does not authorize a retry, except that a new `start:verify`, `start:fix` or `start:land` retries a failed run of the same head, and a new `start:implement` continues an interrupted Implement run that can continue. `start:implement` doesn't retry a failed Implement for the same requirements. The control labels are `start:author`, `start:implement`, `start:verify`, `start:fix`, `start:land` and `agents:stop`, all on the issue.

### Buddy runtime

`src/buddy.ts` is the sole delivery runtime CLI, built as `buddy.mjs`. `src/runtime/` owns configuration, activation/admission, stop propagation, action infrastructure and local run observations. Tasks are libraries, not child stage jobs. The runtime supplies ActionContext and calls task-owned matching/actions. No permanent adapter may run legacy stage roles under new names.

Buddy config uses an explicit organization, repository config paths, one role (or a validated subset of that role's task responsibilities), and one identity with the appropriate account/model/runtime/access/network settings. Role names carry no credentials. Validate profile/account consistency and reject obsolete scheduler/assignment controls before effects.

Land authorization requires an explicit trusted `permissions.land: true` grant in the Gatekeeper buddy configuration and the same repository-scoped grant in the trusted repository configuration. Missing permission defaults to false. Both grants, configured repository scope, Land responsibility and matching landing identity must pass. The fresh ops child rereads the repository grant; the runtime rereads buddy grant, scope and identity before privileged effects. A passed Verify, an approving review or a result signal never itself supplies permission. Ownership and all task prerequisites remain necessary.

The shared revision checking-policy digest includes repository permissions. The buddy-specific action-authorization digest records its scope, identity and grant separately; putting it in `revision.policy` would prevent Developer and Gatekeeper results from sharing a binding. Preserve that distinct authorization evidence with the Land intent. Read-only Land recovery uses current trusted configuration for transport fencing but retains the original Land policy as historical proof, without fresh post-Land checks.

The ops envelope carries `buddy: { config: string; run: string; task: TaskId; authorizationDigest: string }`. These are claims until validated. The runtime writer exports synchronous `bindBuddyAuthorization(cfg, repositoryConfigPath, buddyEnvelope): Config` from `runtime/buddy-config.ts`. The task writer invokes it in `ops.ts` before canonical task-effect dispatch. It rereads trusted configuration, verifies repository config path/scope, role, task responsibility, profile, account/identity and digest, and returns an internal validated `cfg.buddyAuthorization`. It never rewrites `cfg.policyBinding`. Canonical v2 task-effect/attempt/result ops require this context. Runtime envelope fields override task payload fields, never the other way round.

Long synchronous ops can contain several privileged effects. Compose a fresh synchronous buddy-authority check, the appropriate retained signal/result authority check, scoped stop check, and existing execution-owner check at each controlled mutation boundary. A single check before spawning the child is not enough. Keep the uncertain-write journal intact. The runtime writer supplies the fresh buddy checker, the signal writer supplies synchronous human/latch checks, and the task writer supplies current attempt/result source validation and ops composition.

A stop or revoked source prevents new substantive actions, but narrowly defined evidence-only checkpoint, result and read-only-reconciliation settlement remain possible under ownership. Trusted operation semantics select finalization, not a caller-controlled bypass flag. Failed remote finalization preserves local checkpoint/work and retains ownership and consumers.

Land's task-owned `beginAction` acquires and confirms the existing integration turn before recording the Land attempt. An unavailable turn waits with no attempt; an uncertain attempt keeps its turn. The runtime must not acquire a duplicate target-write reservation.

One buddy run UUID per activation; one new action UUID per admitted action. The action UUID is the execution invocation's `instance` and task attempt's `run.id`. The lane is stable per buddy/repo/work-item, not capacity. Every model launch names its parent action but has a separate session identity. Historical jobs are never relabeled as buddy runs.

Stop uses one scoped cooperative control. Stop admission immediately; do not kill credentialed writes, a Git merge or rebase, a review submission or Land in flight on a graceful stop. Abort model-assisted work at a safe boundary; classify interrupted verification as unknown. Preserve progress, checkpoints and journals before release. A failed checkpoint keeps ownership/checkouts/reservations. Escalation remains an explicit process safety valve, not the normal domain stop.

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

The runtime registers before launching and reports done only on confirmed exit. The reservation module uses authenticated shared coordination, not a PID count or local mutex. Repository/base/resource capacity is one shared policy, not independently invented per buddy. Incompatible capacity declarations hold rather than creating disjoint pools or silently oversubscribing. Every live slot request records its cap; only confirmed released/cancelled history stops constraining the pool. Missing live cap evidence holds. Changing capacity requires draining the pool.

Trusted repository configuration must explicitly supply `resources: { modelSessions: positiveInteger }`, without a default. This field belongs to the pinned project document, which every repository configuration must pin, and an operator duplicate is refused. The parent owns `RESOURCE_CAPACITY` in `project-policy-schema.ts` and the shared checking digest; the runtime lane owns Config/schema wiring. `reserveModelSession` holds if its argument differs from the trusted parsed repository cap. Buddy configuration must match the pool cap; a local concurrency limit is not permission to resize the pool. Unknown consumer state keeps the claim. Reuse the current target integration turn and existing consumer-aware test slots rather than creating duplicate pools. The resource writer owns the necessary coordination-schema extension and execution helper. Existing project-facing slot environment variables remain an explicit compatibility boundary.

## Ownership and integration

Every implementation lane has its own worktree, based on the shared-contract commit. Do not edit another lane's files; report required cross-seam changes. Each lane commits its handoff and reports exact validation and omissions. Parent integration resolves wiring and removes obsolete entry points after the component handoffs; it does not invent missing component behavior.

| Lane | Exclusive ownership |
| --- | --- |
| Tasks/effects | `src/domain.ts`, new `src/tasks/**`, `src/roles/**`, `src/ops.ts` canonical registration/envelope, `src/task-result*.ts`, `src/task-results.ts`, `src/ops/**`, `src/state.ts`, `src/saved-state*.ts`, `src/write-authority.ts`, `src/pr-reviews.ts`, `src/land*-authorization.ts`, `src/land-provenance.ts`, `src/reviewed-target.ts`; task-specific integration tests and reference pages |
| Signals | New `src/signals/**`, `test/signals/**`, `docs/reference/signals.md`; no global Config schema edits |
| Runtime | New `src/buddy.ts`, `src/runtime/**` except `reservations.ts`, existing `src/job/**`, `src/config.ts`, `src/config-schema.ts`; runtime integration tests and `docs/reference/runtime-runs.md`; no task/result/ops edits |
| Resources | `src/runtime/reservations.ts`, coordination resource-schema/record support, `src/execution.ts` resource helper and removal of assignment-grant check, `src/lane-slot*.ts`, resource integration tests |
| Parent/integration | Build/install/package manifests; removal of obsolete stage/scheduler/assignment/launcher entry points, final shared import wiring, examples and root/current documentation; dashboard scheduled after observation schema handoff |

Saved work state is canonical v4 `WORK_STATE` (`readWorkState`/`writeWorkState`); the stage-era `IssueState` schema is removed, and a saved state of any other version holds its work item. Land intent belongs to the authenticated v2 attempt. The task writer may delete owned stage roles and obsolete ops even while adjacent job/orchestrator imports still fail. Provide a canonical `checkpoint-action` operation for the runtime and report its exact shape rather than restoring old stage save/release semantics.

Safe Refactor waits on every signal; its runtime act may explicitly refuse with a pointer to `safe-refactor.mjs`. Standalone reports grant no pipeline result.

Temporary compilation failures caused by not-yet-integrated adjacent lanes must be reported honestly. Do not weaken guards, lint rules or types to make an isolated lane appear green. Focused real-file/subprocess/Git tests should prove each lane's own boundary. No unit-test restoration or blanket fixture restoration. Reuse another lane's committed test kit when available; do not create parallel copies of the same fake infrastructure.
