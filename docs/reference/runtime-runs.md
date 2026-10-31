# Runtime runs

The [launcher application](../../apps/launcher/README.md) runs one buddy and launches task apps. Only version 2 buddy files are supported. Task apps claim starts, report their work and recover from GitHub. Landing source changes nothing until the operator installs it.

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
- `claimWaitsMs` is optional and resolved by the launcher for each task invocation. It lists up to 10 pauses, each 0 to 60000 milliseconds, between rereads of the issue timeline while it doesn't yet show the app's removal of a start label. The default is `[500, 1000, 2000, 4000]`.

Each buddy needs its own GitHub account, so that the account that claims a start identifies the buddy. Keep a machine's buddy files in one folder. A buddy refuses to start when another JSON file in that folder names the same account in its `account.login`, compared without case. Buddies on other machines are out of its sight.

### Run a launcher buddy

To check a launcher buddy file without contacting GitHub, run:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/launcher.mjs" --config BUDDY_FILE --check
```

It prints one JSON object with the buddy's name, account, tasks, repositories and the program of each task's app. It refuses the file, and exits 1, for every reason the buddy would refuse to start except an unverified credential.

The launcher finds each task's program as `TASK.mjs` in the install root, `$ECOSYSTEM_INSTALL_ROOT`. It refuses to start when that variable doesn't name an absolute path.

To start the buddy, omit `--check`. Before any other effect, it checks the file and its repository configs, refuses an account that another buddy file in its folder names and refuses a task without a trusted installed program: an operator-owned regular file, not a symbolic link, that nobody else can write. It then reads the token and checks with GitHub that it is the account's.

Each poll lists, for each repository and task, the open issues with `start:TASK`. Pull requests are skipped. For each issue, the buddy runs:

```sh
node "$ECOSYSTEM_INSTALL_ROOT/TASK.mjs" --invocation
```

The launcher sends a validated nonsecret invocation on standard input and provisions credentials through a separate inherited pipe. Children receive no buddy-file path. The [launcher contract](../../apps/launcher/README.md#task-subprocess-boundary) defines these channels.

The buddy checks nothing else first: not `agent:TASK:running`, earlier results nor `agents:stop`. The app's claim decides which buddy runs a start, and the app holds while `agents:stop` is on the issue. So the buddy runs every start it sees, two runs of one task on one issue can overlap, and an app launched for a start that another app already took ends quietly. An app that fails doesn't stop the buddy, which leaves the reporting to the app.

SIGTERM or SIGINT ends the polling. The buddy then waits for the apps it launched to end, prints `{"buddy": NAME, "kind": "stopped", "reason": TEXT}` and exits 0. It doesn't signal its apps, though a terminal's Ctrl-C reaches every process in its group. To end their runs too, apply `agents:stop` to their issues, or signal the apps. A refused configuration or an unverified credential exits 1 with the reason on stderr.

### Launcher log

The buddy writes one JSON line to stderr for each app that ends:

```json
{"at": "TIME", "buddy": "NAME", "task": "TASK", "issue": "OWNER/REPO#N", "pid": 123, "exit": 0, "signal": null}
```

`exit` is the app's exit status, or null when a signal ended it, and `signal` names that signal. An app that couldn't start has an `error` instead of `pid`, `exit` and `signal`. A listing the buddy can't read writes a line with its `repo`, `task`, `"state": "warning"` and a `reason`; the next poll tries again. The apps' own output joins the buddy's stderr, so that its stdout holds only its final line.

## Task app runs

A task app is one task's command-line program, built on the task app framework in `apps/issue-host/src/task-app/`. A [launcher buddy](#launcher-buddies) runs it for each start label it sees. Gherkin's app is `gherkin.mjs`. Implement runs as `implement.mjs`; see [Implement](#implement). Verify's app is `verify.mjs`; see [the Verify task app](review.md#verify-task-app). Fix's app is `fix.mjs`; see [Fix](review.md#fix). The [domain runtime contract](../domain-runtime-contract.md) describes the model it builds.

The launcher runs a task app as `TASK.mjs --invocation`, with the invocation on standard input and the buddy's verified credentials on descriptor 3. The app validates both channels and checks that they name its task and the same account. It never reads a buddy file and accepts no other arguments.

The app exits 0 when its run ends normally: it finished its work, lost the claim, found `agents:stop` before claiming, or stopped on it. It exits 1 when the run failed or it couldn't confirm its claim.

### Claim confirmation

GitHub removes a label only while it's on the issue. When GitHub accepts the app's removal of `start:X`, the app took a start that no other buddy took. The app then reads the timeline until it shows its own `unlabeled` event for `start:X` after the latest `labeled` event it noted before the removal. That event is the run's claim.

If another buddy removed the label first and a person applied it again before this app's removal, the app took the newer start, and it runs it.

### Running label

Each run that wins its claim ends by posting an end comment with a hidden marker that names its claim. It then removes `agent:X:running` only when every claim of `X` on the timeline has an end comment from the account that made it. Afterwards it reads the timeline again, and adds the label back if a new claim appeared while it was removing it.

A crashed run posts no end comment, so its claim holds the label. To release it, a person removes `agent:X:running`. The app counts every claim before that removal as ended. It tells a person's removal from a run's by the actor: a run's account has posted an end comment for `X`, and a person's hasn't. A person who removes `start:X` by hand makes a claim that no run ends, which holds the label the same way.

### Model session

Before launching children, the launcher validates task availability and repository scope.

A task app's work can run one read-only model session, as Gherkin does. An app with a session reads the whole repository config, which must therefore include its project pin, runtime settings and the `credentialsEnvFile` that its mirror fetches use. The session runs `pi` as an installed agent, on the task's pinned prompt page and the repository config's model for its session profile, with the repository config's `runtime`. It holds no GitHub token, can't commit and returns one structured reply, which the app checks against its schema and acts on.

The session works in the run's folder, `runs/SLUG/issue-N/task-runs/TASK_RUN_ID/`:

- `issue.md` is the issue file. It holds the issue and the comments the session may treat as input. A person's comment is shown only when the repository config's `allowedUsers` names them and GitHub still lists them as a collaborator. A task app's marked comment is shown when its author claimed that task on the issue; end comments are left out. Every other comment is withheld. If the issue's own author isn't a trusted person, the run fails before the session starts.
- `repo/` is a detached checkout of the base branch's head, made from the pipeline's mirror of the repository. The mirror is fetched with the repository config's `devAccount` credential. The app removes the checkout when the session ends.
- `sessions/` holds the session's JSONL and its reply schema.

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
