# Issue pipeline

The pipeline runs configured buddies. A buddy is a launcher of task apps: it watches the repositories in its scope for `start:X` labels of its tasks and runs task X's app for each one it sees. The task app framework claims the start, marks the issue, does the work and reports. The buddy does nothing else.

Until #254 removes it, `buddy.mjs` still runs the earlier buddy runtime for a version 1 buddy file. That runtime activates task loops, admits actions and records buddy runs and action runs; the sections after [Tasks and signals](#tasks-and-signals) describe it. Don't run a launcher buddy and an earlier buddy on the same repository: the earlier runtime doesn't claim starts, so both could act on one start.

Landing a change doesn't install it. To make it take effect, drain the buddies, install and restart them; see [install and safe upgrades](#install-and-safe-upgrades). Start with the [pipeline reference](../../docs/README.md), [domain contract](../../docs/domain-runtime-contract.md), [runtime configuration and run records](../../docs/reference/runtime-runs.md) and [operations](../../docs/reference/operations.md).

## Configure a buddy

A launcher buddy file is private operator-owned JSON, version 2. It names the buddy's scope (the repository configs it covers), its tasks, its single GitHub account and the entry of the operator's private credential file that holds that account's token:

```json
{
  "version": 2,
  "name": "hippy",
  "scope": { "repositories": ["/absolute/path/to/repository-config.json"] },
  "tasks": ["gherkin", "implement", "fix"],
  "account": {
    "login": "DEVELOPER_ACCOUNT",
    "credentials": {
      "file": "/absolute/path/to/credentials.env",
      "variable": "HIPPY_GITHUB_TOKEN"
    }
  }
}
```

The buddy makes every GitHub write through its own account, and so do the task apps it launches. Each buddy needs its own account: keep a machine's buddy files in one folder, and a buddy refuses to start when another buddy file there names its account. The repository config's `devAccount` and `landingAccount` pairing plays no part in a launcher buddy.

To validate a buddy file without starting the buddy:

```bash
node "$ISSUE_PIPELINE_ROOT/buddy.mjs" --config BUDDY_FILE --check
```

`BUDDY_FILE` is an absolute path to the buddy file. Omit `--check` to start the buddy. The [runtime reference](../../docs/reference/runtime-runs.md#launcher-buddies) defines the exact keys, the trust checks, how the buddy launches each app and what it logs. Each task in `tasks` needs its installed task app, `$ISSUE_PIPELINE_ROOT/TASK.mjs`; the buddy refuses to start without it.

## Tasks and signals

Issue delivery has five tasks. The canonical task IDs are `author`, `implement`, `verify`, `fix`, `land` and `refactor-safely`. Developer and Gatekeeper are roles, not saved stages.

| Task | Role and access | Binds | Becomes ready when |
| --- | --- | --- | --- |
| Author | Developer, writer | Requirements | `start:author` |
| Implement | Developer, writer | Requirements | `start:implement` |
| Verify | Gatekeeper, reader | The PR head | `start:verify` for the current head |
| Fix | Developer, writer | The PR head | A request for changes on the head, or Land finding a conflict |
| Land | Gatekeeper, lander | The PR head | An approved head that is ready to merge |

Safe Refactor retains its explicit standalone entrypoint.

**Note:** The installed release still runs the older Harden, Sync, Integrate, Review Security and Complete tasks. This source's five tasks run only once it is installed.

Qualified human events provide the human signals: the `start:author`, `start:implement`, `start:verify`, `start:fix`, `start:land` and `agents:stop` labels on the issue, and a qualified person's review of the issue's linked PR. Acceptance requires the actual event, a qualified human in the configured organization, complete source evidence and durable authenticated provenance. Assignments, PR labels, Apps, machine accounts and a label's current presence alone grant nothing. Removing a label creates no continuation signal.

An authenticated attempt spends its start for the requirements binding even if it fails or the target moves. A person's new start of a failed task retries it, continuing the existing work, and Implement doesn't wait for Author. Authenticated task results drive downstream readiness. Unknown, incomplete or conflicting authority holds work rather than disappearing from the inputs.

After a confirmed passed, refused or failed result, a task removes the start label whose application caused it. It preserves all accepted signals and task records, other labels and any newer application observed during cleanup. Uncertain results retain their label. Cleanup failures warn without changing the result. See [completed starts](../../docs/reference/stops-and-labels.md#completed-starts).

Implement writes the change and hardens it in a fresh session before it records its result. Verify runs the full checks, the required CI and the Security review of the exact head. It then submits a review through the landing account: an approval for nothing or only nits, and a request for changes otherwise. A Security finding always blocks. Fix merges the base into the PR head, answers every blocking comment with code and a thread reply, and pushes. An issue gets at most three Fix rounds that Verify triggered (`VERIFY_FIX_ROUNDS`), then holds for a person. See [Hardening, Verify and Fix](../../docs/reference/review.md).

## Ownership, resources and preservation

Each action has a fresh UUID shared by its execution invocation and task attempt. Buddy runs and model sessions have separate IDs with explicit links. Names, lanes, PIDs and timestamps cannot manufacture lineage or authority.

Authenticated coordination and create-only epoch refs fence issue execution. Controlled substantive mutations freshly check the buddy grant, source authority, stop state, ownership and saved write authority. Lost responses retain exact-intent journals; an expired lease or ended process releases nothing. [Coordination](../../docs/reference/coordination.md) describes the boundary.

Issue assignment is for display and grants nothing. If a person is assigned to an issue, Implement and Fix wait for them without a claim, a post or a spent start. Once Implement or Fix records an attempt, the development account assigns itself, and it removes only itself when the action settles and releases the issue. See [issue assignment](../../docs/reference/coordination.md#issue-assignment).

Model-session slots belong to one shared repository/base/resource pool. Live cap mismatches hold the pool. Holders release only after all registered consumers durably finish; pending setups and retained checkouts can retain resources. Resize only after the pool drains. Land separately takes the target's integration turn before recording its attempt; an uncertain Land retains that turn.

Stops are cooperative and scoped to the buddy or work item. Do not kill an in-flight credentialed write, merge, rebase, review submission or Land. Evidence-only settlement remains subject to its recording authority and ownership; it cannot smuggle a new substantive effect past a stop. No undefined restart or continuation operation is supplied.

Before removing an owned checkout, preserve staged and working changes as independent binary-safe patches and local commits as verified bundles. A stopped rebase, failed preservation, uncertain checkpoint, unresolved journal or surviving consumer retains the required checkout, evidence, ownership or reservation. Never discard work merely to make another action eligible. Read-only recovery settles the original action instead of replaying its mutation.

## Land through the PR

Land merges the item's PR with a merge commit, pinned to the exact head it checked, and then closes the issue. One Land result covers both. It needs a passed Verify of the current head, so the Security review always runs first, an approval standing on that head, from Verify or a qualified person, and no standing request for changes. The head must contain the base, required CI must be green on it, and the trusted repository must grant `permissions.land`.

The landing account merges with `gh pr merge PR --merge --match-head-commit HEAD`, so GitHub refuses the merge if the head moved. There is no squash, rebase, direct base push or admin bypass. A conflicting PR isn't merged: Land marks it a draft and records why, and Fix becomes ready. To stop the base moving between Land's checks and its merge, require branches to be up to date before merging on the base.

Before the merge, the authenticated attempt records Land's intent. A lost acknowledgement doesn't permit another merge. Reconciliation reads the PR's merged state and the issue's state. It closes an issue that a merged PR left open, and never merges or closes twice. No suite, code repair or second Land runs after Land. See [Land](../../docs/reference/merge.md).

External actors can still change PRs, inputs, permissions and refs. These guards are not an atomic transaction over GitHub and Git, an operating-system sandbox or permission to deploy a repository whose source base is named `main`.

## Standalone tools

[Safe Refactor](../../docs/reference/safe-refactor.md) provides an explicit non-mutating check and a narrowly assigned tool-mediated writer. Its reports and checkpoints grant no Implement, Verify or Land result. Buddy tasks do not silently schedule it.

[Standards upgrade](../../docs/reference/standards-upgrade.md) assesses a repository read-only. Its `apply` command validates the issue/plan and prints a human `start:implement` handoff, not a stage-launch command or execution grant.

## Read-only Git subagent

`agents/git-reviewer.md` is a dedicated supervisor-usable agent, not a replacement for the shared writable `issue-pipeline-reviewer`. Install includes its explicit `subagentOnlyExtensions` path to `git-review.mjs`; naming a tool without loading that extension is insufficient. The agent has exactly `read`, `grep`, `find`, `ls`, `git_review`, no shell/write/commit tool. Supervisors must launch it with resource discovery disabled and without unrelated extensions/MCP servers that would add command execution authority. Existing hardening, Verify and Security authority and prepared bundles are unchanged.

The trusted supervisor provisions `PI_GIT_REVIEW_ROOTS` **in the child session environment** as a nonempty JSON array of absolute local repository roots. It must narrow this per task, not accept a repository's or reviewer's assertion of authority. Missing/malformed authority fails closed. Task text is not environment configuration. Use `cwd` equal to a canonical allowed repository root (subdirectory cwd is not supported):

```json
{"cwd":"/local/review/repo","argv":["diff","BASE..HEAD"],"offset":1,"limit":200}
```

Pass immutable commit IDs for assigned reviews. The reviewer can request later pages directly and independently inspect history, for example:

```json
{"cwd":"/local/review/repo","argv":["log","--oneline","--max-count=20","HEAD"]}
{"cwd":"/local/review/repo","argv":["blame","--line-porcelain","HEAD","--","src/file.ts"]}
{"cwd":"/local/review/repo","argv":["grep","-n","-e","pattern","HEAD","--","src"]}
```

The tool accepts only `diff`, `show`, `log`, `rev-parse`, `merge-base`, `ls-tree`, `cat-file`, `status`, `blame`, `grep`, with an explicit conservative option grammar in `src/job/git-review-policy.ts`. Paths follow `--`, grep patterns follow `-e`; pathspec magic, traversal, metadata paths, escaping symlinks, global options and unknown modes are refused. Supported common modes include patch/stat/name-only diff, cached diff, oneline/builtin log formats, numeric attached `--max-count=N`/`-nN`/`-UN`, revision verification, recursive trees, `cat-file -p/-t/-s`, porcelain status, and porcelain/numeric `-LN,M` blame. Arbitrary pretty formats, signature verification, `--no-index`, contents/pattern files, batch/filter modes, external programs and alternate Git directories are not supported.

Git is spawned directly as `/usr/bin/git`, never via a shell, with a constant minimal environment, an empty temporary HOME, no host/global/system Git configuration, no credentials/askpass/agent or inherited execution overrides, no terminal input, and file-only transports. A private metadata view omits **all** repository configuration and hooks; applicable diff commands force `--no-ext-diff --no-textconv`. Only a plain `.git` directory is supported; linked worktrees/gitfiles, reftable, metadata symlinks and object alternates are refused. SHA-1 and SHA-256 object stores are supported. Query execution does not write the original files/index/refs/config; optional locks are disabled. Temporary views are removed after Git exits. The private view's object store is local; no fetch or lazy credential discovery is authorized. Worktree queries preflight the private index and check implicit tracked paths too, including dangling/escaping symlinks. `diff` and `status` fail explicitly when an indexed submodule is initialized: Git could otherwise start a child in that submodule and load its untrusted configuration. Use `show`/`log` for committed evidence (including gitlink changes), or inspect a standalone submodule clone with its own explicit root authority; no submodule evidence is silently omitted.

Output is cached per canonical repository and exact requested argv for this session. Limits: 32 MiB complete query output, 30-second execution timeout, UTF-8 output, 8192-byte requests, at most 1000 lines and **48 KiB for the serialized entire result**, including metadata/END. Oversized page limits are capped. If a line cannot fit intact, that offset returns an explicit error with no served-range record. Narrow oversized queries; do not claim missing evidence was read.

Each successful tool-result `details` records `sessionId`, `queryId`, `repository`, `argv`, `totalLines`, `exitCode`, `startLine`, `endLine`. `exitCode` preserves successful predicate outcomes, including 0/1 for `merge-base --is-ancestor`; both outcomes can have empty output. Ranges are one-based/inclusive and represent **actual** delivery, not the requested limit. Empty output has `totalLines: 0`, null bounds and END, not a fictitious line. Only the page reaching the last line carries `=== END ===`. Failures have error details, not coverage. On session start the cache/identity resets; resuming another session does not inherit evidence records.

For chunked reviews, assign the root and exact query, not generated diff files. Inspect the reviewer's persisted tool-result details/session records. Group by session/query/repository/argv, confirm consistent totalLines, sort and union successful inclusive ranges; require every line `1..totalLines`. Repeats/overlaps count once; another query/repo/session cannot fill a gap. An END marker or reviewer claim alone proves nothing about earlier pages. Delivery is not comprehension, review quality, landing authorization or security clearance.

This is the **Git execution boundary**, not an OS/filesystem/keyring/network sandbox. The retained read tools can read same-user files and are not confined by this root allowlist. Do not promise universal credential-file isolation. Optional macOS sandboxing, writer shell isolation, credential rotation and production deployment are outside this feature. Landing does not install or activate it.

## Two GitHub identities and operator credentials

This section describes the earlier buddy runtime. A launcher buddy has one account of its own, as [Configure a buddy](#configure-a-buddy) describes.

Development (`devAccount`) owns code/docs
commits, source branch pushes, PR create/edit/reopen/close/ready and Fix's
replies on review threads.
Review/merge (`landingAccount`) owns every other comment,
saved state, claim, label, authority read and task record. It also submits
Verify's PR reviews and makes Land's PR merge, its draft of a conflicting PR
and its issue close, because GitHub doesn't let a PR's author review it. The installed release still lands with an
explicit-target fast-forward push. Closing a PR uses development; its accompanying comment uses the landing account.
Neither bot is a trusted human, even if included in `allowedUsers`. Human issue
and comment authors require both that explicit allow-list and a fresh collaborator
check; revoking either stops trust.

Configure distinct `devAccount` and `landingAccount` and an absolute
`credentialsEnvFile` pointing to a private operator-managed file (owner-only
permissions, for example mode 0600), outside managed job worktrees, such as the
operator checkout's ignored `.env`. Required entries are
`ISSUE_PIPELINE_DEV_GITHUB_TOKEN` and `ISSUE_PIPELINE_LANDING_GITHUB_TOKEN`.
Never put token values in JSON, prompts, examples, logs or command arguments.
The loader parses that one file, takes only the selected fixed variable and never
exports dotenv values. Each selected credential is login-verified (cached only
for that account/token in the current process); missing/swapped credentials fail
closed, with no ambient, personal, keyring or role-token fallback. Public/model
config omits the file path. Login checks use the shared safe-read backoff:
four attempts, waiting 2/4/6 seconds, with the existing 120-second command timeout.
Network/transport failures, HTTP 5xx and secondary rate limits are transient;
a named wrong login or HTTP 401 fails immediately, taking precedence over
transient text. Only successful account/token verification is cached. Errors
distinguish wrong account, authentication rejection and unverifiable identity,
with gh exit status and a stderr excerpt of at most 1024 UTF-16 code units
including the truncation indicator. Selected-token redaction precedes truncation;
empty stderr is explicit. Verification retries never repeat the requested write.

Ordinary model/shell children lose both fixed token variables, ambient GitHub
tokens, the landing token's pre-#166 variable name and inherited Git credential/debug
injection. Privileged calls receive only their selected `GH_TOKEN`; diagnostics
redact it. Git uses a non-storing per-call helper, no personal/global helper,
HTTPS repository allow-listing and no redirects. Local test origins receive
no credentials. Submodule authentication is limited to the configured repository.
The installer never provisions operator credentials; release workflows remain unchanged. Keep the operator file out
of `apps/web/` and its app-local env files: Next/Drizzle run from that folder,
and web tooling that uses `--env-file` names its own app-local files. Never add
the operator file to a build/deploy `--env-file` invocation or export it into a
web process. Pipeline build tasks do not load it.

Every landing-account-authored comment is reread through GraphQL with body,
author, `lastEditedAt` and `editor` in the same response. Unedited comments
require null edit time/editor; edited comments require the landing account as
editor. Issue-local reads check every landing-authored comment, including removed
markers.

Repository-wide coordination reads check provenance only when either
the listing or the current reread contains the coordination marker. They do not
consume ordinary discussion or unrelated historical state and task receipts.
Missing or unreadable provenance still stops the read. Untrusted provenance on
a selected comment stops for reconciliation rather than falling back to an
older or empty receipt. These semantics still need the operator verification
below.

This is not a same-OS-user sandbox: a child under the operator's user may still
read the credential file.

## Config and model cutover

Operator config lives in `$ISSUE_PIPELINE_ROOT/repos/`, starting from `repos/example.json`. Every config pins the repository's committed `.issue-pipeline.json` with `projectPolicy`; there is no flat-config mode. `src/config-schema.ts` defines operator shape/defaults. [Project settings](../../docs/reference/project-settings.md) describes the strict tracked `.issue-pipeline.json`, operator-owned identity/safety controls, the trusted full-commit pin and the policy binding. Candidate settings edits never activate policy for the same candidate. Every newly computed authorization revision binds its checking policy. Config keys the pipeline no longer reads are ignored without a warning, and keys renamed in #166 are read only under their new names.

The default and example role models are `openai/gpt-6.1-sol`. Set all three repository roles explicitly rather than relying on old-role aliases:

```json
{
  "models": {
    "author": "openai/gpt-6.1-sol",
    "developer": "openai/gpt-6.1-sol",
    "reviewer": "openai/gpt-6.1-sol"
  }
}
```

All model sessions now require the explicit, separately provisioned [native runtime policy](runtime/README.md): trusted **Pi 1.2.0 + pi-cliproxyapi 0.4.3**, a dedicated model-child HOME, explicit provider extension/profile/cache, declared model credential **names** and reviewed native context-window expectations. The supported starting profile is builtin OpenAI through a distinct proxy endpoint. Set `runtime.modelContextWindows` explicitly; there is no inferred expectation. See `repos/example.json` and the nonsecret `runtime/pi-cliproxyapi-config.example.json`. Model strings pass unchanged to `--model`; unsupported registrations refuse rather than falling back.

Native automatic compaction targets **175000** tokens with **30000** recent-history tokens. For the expected 272000-token window, reserve is **97000**. This is same-session native context management, not a token/spending cap. Private generated agent settings, disabled project/personal resource discovery and correlated pre-prompt native verification enforce policy for every role. Only explicit provider/role/pipeline resources load; inherited extensions are no longer used. This is configuration isolation, **not** an OS/filesystem/keyring/network sandbox. The buddy runtime and credentialed operations keep their own HOME and two-account boundary. Global/personal provider setup is neither copied nor changed. Tests use fake models and local origins only.

This ordinary backlog continuation is not a prerequisite for unrelated delivery. No first-issue, queue-off, session-reset or historical install/provision/STOP restriction is restored. Development uses the operator's `devAccount` (hippy for this issue); review/approval/landing uses the distinct `landingAccount` (lawd). These names are operator choices, not hard-coded identities. Credential rotation is outside this change.

## Programs and observations

`programs.ts` is the shared build, install and syntax-check manifest. Current programs include `buddy.mjs`, `database.mjs`, `ops.mjs`, `shell-supervisor.mjs`, `structured-output.mjs`, `pipeline-commit.mjs`, `git-review.mjs`, `safe-refactor.mjs`, `safe-refactor-tool.mjs` and `standards-upgrade.mjs`.

Canonical observation files are `runs/buddy-runs/ID/run.json` and `runs/SLUG/issue-N/actions/ID/run.json` for the earlier runtime and, for [task app runs](../../docs/reference/runtime-runs.md#task-app-runs), `runs/SLUG/issue-N/task-runs/ID/run.json`. A launcher buddy writes no observation file of its own. They grant no authorization. The [dashboard](../workflow-dash/README.md) distinguishes buddy runs, action runs and generic subagent runs. Missing evidence and bounded read coverage remain explicit; a process observation cannot release capacity or make an action live.

A launcher buddy writes one JSON line to stderr for each task app that ends, with its task, issue and exit status, and one for each listing of start labels it can't read. Its task apps' own output joins its stderr. See [the launcher log](../../docs/reference/runtime-runs.md#launcher-log).

Earlier buddies write one JSON line to stderr for each new or changed loop hold,
each action that ends without success and each failure an action goes on past,
such as a failed issue assignment. Hold lines include the timestamp, buddy run,
repository, task and reason. Action lines also include the action ID and
outcome. Warning lines include the action ID, `"state":"warning"` and the
reason. An unchanged hold logs once per loop across polls; after a cycle
clears it, the same hold can log again. Stdout retains the CLI's final run
summary. Redirect both streams to capture these diagnostics in operator logs.

## Database coordination

Private operator config can select the shared `@ecosystem/db` PostgreSQL backend
for issue ownership, model-session slots/consumers and Land integration turns.
A transaction creates a claim once; relational constraints enforce exclusivity,
source ownership, capacity and safe release. Claims and audit history retain
database-generated timestamps, action and buddy identities, task and reasons.
GitHub remains the default; requirements, signals, attempts/results and human
conversation remain there under either backend. The database is short-term
storage: a reset or a second database can let two buddies work on one issue,
and fast-forward-only pushes, recovery branches and the GitHub task records
keep that collision from losing work.

The installed `database.mjs` reads a separate private credential file. It does
not migrate schema, adopt old claims or fall back to GitHub on failure. Every
participant for a repository/base must use the same backend. Read the
[database reference](../../docs/reference/database.md) before provisioning or
cutover. Source changes authorize neither live selection nor deployment.

## Install and safe upgrades

Run source and assets only from an installed copy. Landing doesn't change that copy, credentials or model provisioning. Before landing, run the full gate:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:full
```

Run at the monorepo root under Node 24. A fast pass is not full runtime coverage.

To install, stop the buddies cooperatively and let their in-flight actions settle, then install and restart them. Old and new runtimes must not run together, because they can claim the same work twice:

```bash
mise //apps/issue-pipeline:install:dry-run
mise //apps/issue-pipeline:install
```

The installer backs up the files it replaces and records `INSTALLED.json`. It removes no file it doesn't install. It does not rewrite operator configs or provision credentials.

Prompt pages and agent definitions are installed assets. Prompt selection and tool authority remain checked by code; a prompt cannot grant credentials, commit scope or permission. Preserve pinned prompt bytes, hashes, receipts and recovery artifacts through cutover. A binary rollback does not undo Land or clear a Security rejection.

For a source defect, preserve the affected action and deliver a tested fix, then install it. There is no restart-at-stage recipe. An uncertain Land permits only its supported read-only reconciliation, never a blind retry. See [operations](../../docs/reference/operations.md#recover-after-a-source-defect).

## Tests

At the repository root:

```bash
npm run check        # apps and shared database fast gates; no full runtime coverage
npm run check:full   # database static gate, pipeline non-external tests, dashboard gate
```

From this folder, `check`, `check:full`, `typecheck`, `lint` and `build` run this app's scripts. mise is optional and calls the same scripts.

The pipeline fast gate checks source/test types, Biome, build, installer syntax and all ten built programs. It runs no pipeline Node tests. The full gate discovers `test/**/*.test.ts` under every level folder except `test/system-integration/`, with file concurrency 8 and per-test timeout 180000 ms.

Tests are sorted by ISTQB test level, as the [project practices](../../docs/project-practices.md#tests) define them. Each level has its own folder and script, with the full gate's flags:

| Folder | Level | Script | Holds |
| --- | --- | --- | --- |
| `test/component/` | Component | `npm run test:component` | the task ledger, read alone in a child process |
| `test/component-integration/` | Component integration | `npm run test:component-integration` | signals, including Author and Verify starts and PR review signals, reservations, project policy, buddy authorization binding |
| `test/system/` | System | `npm run test:system` | buddy flows of the built `buddy.mjs`, among them Author, Implement's hardening, Verify, Fix, Land and their recovery, `buddy --check`, `standards-upgrade apply`, the distribution |
| `test/system-integration/` | System integration | `npm run test:database` | real isolated PostgreSQL, relocated database bundle and reservation adapter; requires explicit test setup |
| `test/support/` | none | none | helpers more than one level uses, such as the fake GitHub server and signal kit |

The separate [database suite](../../docs/reference/database.md#test-the-database-contract) creates fresh databases on a supplied disposable PostgreSQL server. Root `npm run test:database` runs both shared-store and pipeline database tests; it is not included in either default gate.

[Writing a test](test/README.md) says what each level fakes, which kit to start from and how to run it.

Fake GitHub is one server process per test machine (`test/support/signals/fake-gh-server.ts`). The `gh` on the machine's `PATH` is a small sh script that forwards each call to it with `curl --unix-socket`.

Tests use temporary HOME/pipeline roots, local Git origins and fake GitHub/model processes, never real credentials, models or production data. Set disposable roots before dynamic imports. Test real files, subprocesses, Git and public operations; do not replace task behavior with success stand-ins and call it integrated acceptance. A failure or flake blocks acceptance; fix the cause instead of repeating the same test for a pass.

Full suites are explicit and pre-Land, not a post-Land repair loop or installation prerequisite rerun. Follow the effective checking policy and record exact coverage omissions. [Gate scope and cost](../../docs/reference/check-gates.md) distinguishes fast checks from runtime proof. Installed-artifact acceptance remains a separate operator action.
