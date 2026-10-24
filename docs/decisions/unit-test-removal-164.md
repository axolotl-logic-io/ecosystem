# Issue #164 test-removal ledger

On 2026-10-22, Autumn approved removing the issue pipeline's isolated direct-call tests. The [decision](code-and-tests.md#no-unit-tests) replaces the unit-test rule. This ledger records lost assertions so Autumn can decide which behaviours need full-flow or integration tests. No replacement tests are part of this change.

## Scope and counts

The corrected owner manifest removes 73 whole test files (420 static declarations), 19 cases across five mixed files and eight helpers or fixtures whose remaining-consumer closure is empty. All other helpers stay unchanged. No production source, discovery documentation or check configuration changes. A later pass, recorded under [Second pass](#second-pass), converts or removes ten more pipeline cases and removes workflow-dash's direct-call tests.

| Source measure | Before | Removed | After |
|---|---:|---:|---:|
| Test files | 278 | 73 | 205 |
| Static source-text matches, using the inventory's method | 1,335 | 439 | 896 |
| Parsed `test(...)` call sites, including calls inside loops | 1,334 | 439 | 895 |

These are **static counts, not executed test counts**. The source-text method counts lines matching `^\s*test\(`. Its one extra match is a generated test declaration inside the `FIXTURE` string in retained `bounded-test-kit.test.mjs`. Loops and generated tests expand at runtime. No measured runtime baseline is available for this exact base. The full gate on the landed revision ran 1,381 pipeline tests and 16 workflow-dash tests, all passing; PR #191 records the run.

The source tree was compared with the reconciled main revision `c3134206c0e94fa81b53c6dde1d14bc9b2877cb7` before editing. The issue-pipeline tree and three practice/decision pages had no relevant deltas. The ledger below comes from the actual removed source, not the superseded 77-file inventory.

## Lost safety and validation assertions

Every removed case appears below. This is a conservative ledger of all lost direct assertions, including those with partial overlap in retained integrations. A full flow executing a code path is not evidence that it asserts every former decision or refusal. In particular, the following sole direct assertions are lost:

- **Security and merge authority:** role-level candidate, Reviewer, Security, rejection, replay and project-policy matrices; exact hardening/target/input bindings; movement during Security; historical clearance not supplying premerge permission; durable rejection surviving stop lifting or policy changes; independent result provenance; exact-result checks before completion; no repeat uncertain merge or postmerge writer; integration/check/conflict bounds and refusal outcomes.
- **Requirements and saved authority:** direct versus authored routing, unanswered-requirement holds, optional Author checkpoints and return stages, claim-marker identity and expiry, legacy state parsing, malformed approval fields and null legacy wiki handling.
- **Commit flags and paths:** refusals for `--amend`, abbreviated `--amen`, `--no-verify`, `-n`, combined `-an`, `--author` (separate or attached), `--date` (separate or attached), `--reset-author`, `--pathspec-from-file`, `-F -` and `--file=-`. Lost path assertions include disallowed code paths, traversal, absolute paths, pathspec magic, paths outside `repo/`, sibling `docs/` and read-only access. Message-file resolution, session trailers, argument routing and dry-run planning assertions also go. Retained real-git commit tests do not replace the flag/path refusal matrix.
- **Session authorization and credentials:** per-stage agent/session/phase matrices, read/write scope including after merge, removal of all token variables and configured or registered legacy credentials from session environments, and refusal to inherit commit scope. Synthetic-definition cases for read-only tool filtering, default tools, extensions, thinking, discovery policy and prompt text not granting authority also go. Retained real-repository definition guards and job boundary tests overlap, but do not replace those synthetic matrices.
- **Session lifecycle and privacy:** scripted role-run failures, identity rejection despite transient errors, exit-push restrictions, non-stop signal checkpointing, the structured-output flag/event registration contract, usage accumulation and serialization. Sole privacy assertions lost include refusal of free text, absolute paths, unknown keys and comment terminators in usage records, omission of task/reply text, and IP-address redaction. Durable stop-recovery evidence, usage append, and the original structured-output schema-file parameters, termination/details and missing/non-object-file refusal tests stay.
- **Discovery authentication and completeness:** all 42 cases across seven discovery suites. No retained test covers these grants, actor/App identity, current-collaborator and revocation rules, handoff provenance, pagination completeness, contradictory evidence, opt-in, duplicate/case-insensitive mappings, requirements revisions or deduplication rules. All `src/discovery/` files and the documented opt-in interface remain.
- **Coordination and execution validation:** pure interleaving, authority/linkage/provenance/refusal matrices, release/order/cancellation rules, changed UUID/lane/branch/issue bindings, unique execution IDs, permissive config refusal and repository JSON not activating internal hooks. The actual-file unknown-operation journal/restart refusal and recovery suites stay; their assertions are not listed as losses.
- **Configuration, scheduling and transport classification:** config/model precedence and defaults, removed-key warnings, wiki refusal, merge-confirmation bounds, duplicate JSON keys, scheduler caps/prerequisites/leases/merge window/restarts/backoff/completions, transient/network/rate-limit classification, labels, glob matching, read-command classification and state-comment parsing.

## Retained boundaries

The retained tests include real jobs and ops, git, durable filesystem writes, subprocesses and repository artifact guards. In particular, the 18 genuine fake-gh subprocess suites remain, including `job/merge-attempt-runner.test.mjs`. Credential, redaction, identity and transport assertions in them are unchanged.

The five mixed files preserve all assertions in their designated real-boundary cases: coordination's unknown-operation journal/restart refusal; stop-recovery JSON readback; actual repository agent definitions and missing-file launch refusal; the esbuild entrypoint reachability guard, with its build import; and structured-output schema-file loading and missing/non-object-file refusal. The two structured-output cases and their required scaffolding are restored unchanged from `c3134206` after the owner corrected their classification; only the isolated flag/event case is removed from that file. The coordination world, role-job kit, usage fixtures, explicit-target kits and implementor resolver helpers remain.

Retained ops and full-flow tests overlap parts of merge authorization, explicit-target recovery, Security, claims, job session access and scheduling. They are not relabeled as replacements for the lost role decision matrices, privacy guards or discovery assertions. No new skips, pending cases, todo metadata or replacement coverage are introduced.

## Removed cases

Each heading names an original path under `apps/issue-pipeline/`. Each bullet names one removed static case, with its original line number. `${…}` expressions are the original template titles; their parameterized variants are not measured runtime totals. Cases protected by the corrected owner manifest are excluded.

### `test/claims.test.mjs`

- Line 32: a claim the pipeline posted counts
- Line 42: a person quoting the claim marker from the same account doesn't count (#120)
- Line 53: a pipeline comment of another role carrying the claim marker doesn't count
- Line 58: a claim from another account doesn't count
- Line 65: a claim not edited for leaseHours has expired
- Line 73: a closed claim doesn't count

### `test/comments-usage-role.test.mjs`

- Line 40: the account's usage comments are the pipeline's usage records
- Line 48: a usage comment's body from another user is not the pipeline's
- Line 55: a signed pipeline comment that quotes a usage mark keeps its role
- Line 60: an unmarked bot comment after the questions does not change it

### `test/config-context-limits.test.mjs`

- Line 63: removed config key ${key} loads, warns once and grants no configuration
- Line 74: values loadConfig once refused no longer stop a config loading
- Line 85: a config without them loads with no warning

### `test/config-merge-confirmation.test.mjs`

- Line 15: confirmation config has safe defaults and refuses unbounded or busy-loop settings

### `test/config-models.test.mjs`

- Line 16: each role's own key wins over the installed version's roles
- Line 25: installed-version roles map to the new roles in their documented order
- Line 44: no models at all gives every role the OpenAI default
- Line 52: an unused legacy model role cannot replace the default reviewer
- Line 62: explicit models survive the default switch without a fallback

### `test/config-wiki-removed.test.mjs`

- Line 15: a config with wiki ${JSON.stringify(wiki)} fails, naming the key to remove
- Line 20: a config without wiki loads

### `test/coordination-hardening.test.mjs`

- Line 12: a ref changing after confirmation cannot transfer authority through ${transition}
- Line 59: conflicting reservation read-back holds before appending an owner confirmation
- Line 92: an authenticated request with a mismatched ${binding} cannot enter an issue scope
- Line 129: a ${kind} cannot hide invalid linkage by changing to another valid scope

### `test/coordination-interleaving.test.mjs`

- Line 55: atomic acquisition fences interleaved ${lane} lanes with incomplete initial listings
- Line 110: an omitted confirmed owner holds the ${lane} lane contender without touching order or refs

### `test/coordination-validation.test.mjs`

- Line 21: ${transition} rejects ${invalid} evidence without rewriting history
- Line 74: request and successful immutable reservation alone cannot save or release
- Line 93: ${scope} cancellation removes only its exact pending request in durable order
- Line 132: a reused UUID with a changed lane, branch or issue cannot acquire or cancel

### `test/coordination.test.mjs`

- Line 31: ${scope}: two ${lane} lanes never share execution permission
- Line 45: ${scope}: confirmed release preserves order and permits a new instance
- Line 69: ${scope}: expired heartbeat cannot resolve ${evidence}
- Line 101: ${scope}: a lost ${operation} response needs exact read-back, not a retry
- Line 116: integration order is reconstructed from GitHub, not caller dispatch or a local queue
- Line 143: authority ${condition} never falls back to a permissive record

### `test/discovery/discovery-app-events.test.mjs`

- Line 11: unrelated GitHub App events do not hide authenticated ${kind} work
- Line 36: a GitHub App login is not a trusted human or configured orchestrator

### `test/discovery/discovery-authentication.test.mjs`

- Line 18: assignment grants authenticate ${actor} through GitHub events
- Line 50: holds development review requests with ${mismatch} mismatch
- Line 100: bound merge reviews are evidence only for their recorded PR and revision
- Line 130: unverifiable evidence has stable deduplication identities and no writes
- Line 144: bot, visitor and recognized legacy comments cannot answer questions or move input revisions
- Line 165: trusted input changes return development to Author and do not offer review
- Line 182: assignment preserves ${control} control
- Line 213: normalizes actual GitHub REST wire names

### `test/discovery/discovery-bounds.test.mjs`

- Line 15: ${kind} ${failure} between pages is an incomplete listing
- Line 73: missing ${evidence} reads never grant eligibility
- Line 102: a full page without Link metadata requires another bounded read
- Line 132: revoked issue authors cannot grant work even through merge orchestration
- Line 143: a current reviewer list alone cannot establish a handoff
- Line 155: extra team requests cannot enlarge development's reviewer scope
- Line 166: recorded review evidence absent from GitHub remains incomplete
- Line 178: open parents are relationships, closed after markers satisfy prerequisites

### `test/discovery/discovery-hardening.test.mjs`

- Line 18: prior ${evidence} cannot be rediscovered as fresh development
- Line 54: ${kind} contradictory ${relation} pagination is incomplete
- Line 76: unrelated historical team requests do not invalidate a scoped user grant
- Line 95: a recorded request cannot also be recorded as predating its handoff
- Line 108: a comment page missing ${missing} cannot establish complete inputs
- Line 132: a partial Link header cannot terminate a full listing page
- Line 151: a full final page with coherent Link metadata is complete

### `test/discovery/discovery-listing.test.mjs`

- Line 13: discovers authenticated development and scoped review in ${repository}
- Line 42: explicit opt-in and valid configuration are required before any read
- Line 73: fails closed on ${mode} mapping boundaries
- Line 122: includes ${kind} from the second page
- Line 174: reports ${failure} as incomplete, never as authoritative emptiness
- Line 203: a fully read empty queue is complete
- Line 213: identity matching is case-insensitive across mappings and authenticated actors
- Line 239: identical duplicate mappings cannot be resolved by first-match ordering

### `test/discovery/discovery-provenance.test.mjs`

- Line 14: review grants authenticate ${actor} with a recorded handoff
- Line 29: a later removal contradicts a current assignee list
- Line 39: a malformed later grant cannot fall back to an earlier valid grant
- Line 63: duplicate work across pages cannot masquerade as a complete snapshot
- Line 74: only current collaborators' human comments move the existing input hash
- Line 93: same-read comment body replaces stale REST state before parsing

### `test/discovery/discovery-requirements.test.mjs`

- Line 11: authored discovery retains the saved-Gherkin revision guard for ${stale}
- Line 31: direct discovery reviews current trusted requirements without a Gherkin comment and returns changed inputs to Developer
- Line 61: discovery never normalizes malformed requirements authority ${JSON.stringify(invalid)}

### `test/execution-seam.test.mjs`

- Line 22: fresh executions on one stable lane bind unique UUIDs to the exact configured scope
- Line 41: a factory refuses changed execution binding ${JSON.stringify(change)}
- Line 54: execution UUID and lane validation are not inherited from a permissive config
- Line 61: repository JSON cannot activate an internal execution or mutation hook

### `test/github-read.test.mjs`

- Line 20: GitHub read retries ${stderr} without a wall-clock wait

### `test/helpers.test.mjs`

- Line 33: globs match within a segment, across segments, and any leading folders
- Line 43: a signature names the role, agent, model and run
- Line 62: text posted to GitHub names local paths by variable
- Line 91: text posted to GitHub hides IP addresses, with or without a port
- Line 116: only GETs and list or view commands count as reads
- Line 124: a saved state with the installed version's spend fields still loads, without them
- Line 137: a state comment's body gives its state, or null
- Line 164: a job checkout stands in for its own issue's worktree and branch, and for its issue only

### `test/job/branch.test.mjs`

- Line 30: branch ${branch} cannot name issue work
- Line 34: a literal feature branch can name issue work

### `test/job/job-agent-definition.test.mjs`

- Line 195: pipeline discovery policy wins over definition inheritance, and a read-only session gets only tools that read
- Line 210: a definition's thinking and extensions reach pi's command line
- Line 223: a writer session's files add the pipeline_commit extension and tool
- Line 236: a writer session with pi's default tools adds both tools to them
- Line 257: a read-only session of a definition that edits, writes and runs commands gets only the tools that read
- Line 268: a read-only session of a definition naming no tool that reads still never gets pi's default tools
- Line 274: a pinned prompt that names tools and authority is appended as text and changes no tool, extension or flag

### `test/job/job-exit-push.test.mjs`

- Line 26: a writer's exit push pushes nothing once the code is merged
- Line 34: a reviewer job interrupted mid-hardening pushes its commits as it exits
- Line 40: a writer that never claimed pushes nothing, and a reader or merger never pushes

### `test/job/job-login-failure.test.mjs`

- Line 19: identity rejection still stops despite transient stderr: ${classification}
- Line 34: exhausted transient verification retains the ordinary bounded caller deferral policy

### `test/job/job-role-run.test.mjs`

- Line 107: the role sees the claim's top-level issue file
- Line 115: a claim reply with the issue file only under paths doesn't parse
- Line 130: a merge job runs its role on a done issue with its merge recorded
- Line 141: a done issue with no merge recorded, or at another job's stage, is released untouched
- Line 185: an op that fails on the network defers and releases the last saved state
- Line 198: an op that fails on its schema or another error stops the issue as an error
- Line 213: a post on the PR before there is one stops the issue as an error, posting nothing
- Line 226: a role's comment is signed with its role and agent, and returns the first id
- Line 260: the claim hands the exit push the run's last saved state

### `test/job/job-roles.test.mjs`

- Line 88: each stage's boundary has its role, and no stage's session env names a token
- Line 109: the roles' defaults hold with no config, and a config network replaces one
- Line 128: no session env holds a gh token variable or any role's tokenEnv
- Line 136: registered legacy credentials stay hidden even when this role config omits them
- Line 144: no session env inherits a commit scope from the job's own env
- Line 149: only the author reads the code alone; the writers and merge's integration write it
- Line 159: a committing session of review or merge may commit any code path; the author's scope commits nothing
- Line 173: a writer's scope once the code merged commits nothing

### `test/job/job-sessions.test.mjs`

- Line 22: each stage runs its one agent: the reviewer hardens, integrates and reviews security, so merge runs it too
- Line 144: each stage runs only its sessions: the reviewer hardens, committing, in review, and integrates, committing, then reviews security, only reading, in merge
- Line 162: a session with another authority or phase than its stage lists is refused, and so is a reviewer session that names no phase
- Line 169: a stage refuses any other agent's session, whatever its authority

### `test/job/job-stop-signal.test.mjs`

- Line 91: a signal outside stop still saves the last checkpoint without its lease

### `test/job/job-structured-output.test.mjs`

- Line 56: the output extension registers a string --output-schema flag and waits for the session to start

### `test/job/network.test.mjs`

- Line 30: network failures are network errors
- Line 36: other errors, and no error, are not

### `test/job/pipeline-commit.test.mjs`

- Line 50: flags that rewrite history, skip hooks, change the identity or read hidden input are refused
- Line 71: a path outside the session's allowed paths is refused, naming it
- Line 83: a path outside repo/ is refused, naming it and the checkout
- Line 89: a docs/ path beside repo/ is refused: the repo's docs are in repo/docs/
- Line 95: a code path is refused without write access to the code, naming the checkout and the access
- Line 105: pathspecs lose their repo/ prefix, docs included, and go to the code checkout
- Line 134: every commit ends with the session's trailer, naming its launch key and the job's start
- Line 143: a scope without the job's start, as a job started before the trailer sends, commits without a trailer
- Line 154: the call's own message options, trailer and signoff pass through before the session's trailer
- Line 167: a relative message file is read from the job's folder
- Line 176: a scope that may not write code, as after the code merged, plans no commit and refuses a code path
- Line 185: --dry-run passes through and marks the plan a dry run

### `test/job/rate-limit.test.mjs`

- Line 56: rate limits and overloads are rate-limit errors
- Line 62: other session errors, and no error, are not
- Line 68: rate limits, overloads and transport errors in any case are transient
- Line 74: other api errors, timeouts that aren't reads, and no error, are not transient

### `test/job/run-usage.test.mjs`

- Line 62: ${how} gives one session entry, ended ${ended}
- Line 78: a reviewer session's record names its phase as its state, and its stage still as its stage
- Line 94: a session's reply is kept only when it replied
- Line 101: each role's sessions count up their own attempts
- Line 116: the job entry lists its stages, outcome, seconds and its sessions' summed tokens
- Line 142: a job interrupted before any session spent nothing and stayed at its stage

### `test/job/usage-log-records.test.mjs`

- Line 56: first, peak and atFinish come from the first, highest and last turns
- Line 69: a launch with no turns tallies zero contexts and no tools
- Line 79: tool output is counted per tool from tool_execution_end
- Line 92: a session record carries the entry's facts and the job's identity
- Line 97: a session record keeps a model id with its provider prefix
- Line 107: a record from before the session key, job start, 1h cache writes and cost still parses
- Line 120: a record the installed version wrote, with its roles, stages, endings and limits, still parses
- Line 136: a reply's outcome or verdict name is recorded, and free text as null
- Line 152: a tool whose name isn't a plain name is counted under other
- Line 162: the serializer refuses free text, an absolute path, an unknown key and -->
- Line 208: no record holds the launch's task or reply text
- Line 223: a usage body round-trips its lines and its mark
- Line 242: appending past 65,536 characters gives null

### `test/labels.test.mjs`

- Line 13: the status labels keep their names
- Line 36: the stops keep their order and label names
- Line 60: a removed control's label still reads as a stop, and a status label doesn't
- Line 70: a reason maps to its stop, and any other reason to error

### `test/optional-author.test.mjs`

- Line 34: new work starts directly at Developer; explicit Author remains available
- Line 42: saved authored and stopped runs retain their requirements mode and provenance
- Line 63: direct Developer work consumes trusted issue inputs without a Gherkin comment
- Line 75: direct Review and Merge proceed without Gherkin, retaining ordinary checks and read-only Security
- Line 122: changed inputs route author-used=${authored} before hardening or merge
- Line 173: unanswered direct requirements stop rather than invent a requirement or invoke Author

### `test/orchestrator/orchestrator-completion.test.mjs`

- Line 30: an open done issue with its merged revision starts a merge job, with agent:merged or an open prerequisite
- Line 46: a completion is never sent back to the author by new trusted input; the merge role is
- Line 53: a plain done issue, and a completion with a stop label, skip label, untrusted author or live job, get no decision
- Line 65: a completion is still held by another lane's live lease and by a live legacy job
- Line 77: several open completions all start at once, with no merge queue
- Line 91: an open completion bypasses a held merge window but not the caps
- Line 113: a completion, starting or live, never opens, holds or joins the window a code merge needs
- Line 136: code merges keep their window and order beside completions

### `test/orchestrator/orchestrator.test.mjs`

- Line 26: each stage starts, later stages first, then older issues
- Line 41: starts past maxJobs hold at the global cap, counting live jobs
- Line 55: starts past a stage's cap hold, and a legacy live job counts toward maxJobs
- Line 73: an open prerequisite in the after mark holds, and another lane's live lease holds
- Line 98: stop labels, merged, split, skipLabels, untrusted authors, done, live jobs and new work off get no decision
- Line 113: a stopped issue whose stop label is gone starts at the stage it stopped in
- Line 124: changed trusted input sends implement back to implement and review or merge back to review
- Line 146: needs-info holds while the input is the one asked on, and the author starts once it changes
- Line 164: the merge window's holder keeps it while its changed head is reviewed again
- Line 180: with no holder the merge most issues wait on opens the window, then the lower PR
- Line 196: a live merge job holds the window, and a holder sent back to the author gives it up
- Line 215: a dead job restarts at its stage up to maxResumes, then the issue stops
- Line 248: a backoff holds every start and admits no restart

### `test/own-merge-replay-guards.test.mjs`

- Line 61: a claimed own merge reuses exact original authorization for finish without erasing provenance
- Line 74: missing, malformed, stale or rejected saved security refuses the claimed own merge and its done replay
- Line 93: GitHub head, PR and merge commit and both saved and requested code provenance are independently checked
- Line 123: finish binds the saved legacy wiki head and inputs to authorization even if security cleared another result
- Line 143: an independently hardened merge-SHA authorization remains valid
- Line 167: a merge-SHA authorization without confirmed codeMerged cannot replace an own-merge receipt

### `test/project-policy-finish-guard.test.mjs`

- Line 52: finish accepts a new current-policy result observation while preserving unbound original receipt
- Line 62: an old result clearance does not complete work under a fresh effective policy
- Line 72: a changed checking policy cannot erase a historical same-content Security finding
- Line 84: an independent postmerge authorization cannot pretend to be an old own-merge receipt
- Line 94: rewriting the original receipt with today's policy breaks the original authorization chain
- Line 100: wrong original PR, head and merge metadata retain the canonical refusal
- Line 113: wrong code, inputs, legacy wiki or current policy cannot clear another result
- Line 126: unproven or mismatched saved provenance cannot authorize a current-policy result

### `test/project-policy-recovery.test.mjs`

- Line 50: ${stage} recovery checks and readonly-reviews current policy without rebinding history
- Line 89: ${stage} policy drift cannot reroll a same-content historical Security rejection
- Line 135: current policy cannot recover ${invalid.name}
- Line 150: changed trusted inputs do not borrow the historical result or Security
- Line 162: result-policy movement during readonly Security discards the observation and never finishes
- Line 179: a genuine saved successful old attempt gets a new result observation, never another merge
- Line 203: external merged truth without successful original attempt cannot borrow current-policy authority
- Line 231: current-policy checks that fail on a historical result stop without a writer or Security
- Line 250: a historical no-finding receipt is not reusable after policy drift

### `test/project-policy-schema.test.mjs`

- Line 12: project JSON refuses duplicate authority: ${document}
- Line 17: same member names in separate objects and punctuation inside command strings remain valid
- Line 25: duplicate-key validation does not repair malformed JSON

### `test/requirements.test.mjs`

- Line 37: strict saved authority accepts old authored mode absence, but never malformed mode/input markers
- Line 61: changed direct inputs at ${stage} route to Developer without Gherkin
- Line 86: an unchanged direct revision needs no Author and an unanswered requirement remains held

### `test/reviewed-target.test.mjs`

- Line 47: fresh hardening retains the literal repository/branch/base revision reviewed and checked
- Line 62: unmerged saved hardening cannot reuse an unknown or changed target: ${JSON.stringify(target)}
- Line 73: target movement during hardening cannot checkpoint approval against a newly advertised ancestor
- Line 86: old absent target remains readable without inventing historical authority; malformed target fails write validation

### `test/roles/author/author-request.test.mjs`

- Line 66: explicit Author checkpoints direct ${stage} and returns unchanged work there without new approval
- Line 97: interrupted and asked Author passes retain the original return checkpoint without reselecting a mode
- Line 121: a first Author pass with changed ${change} cannot reuse old approval
- Line 146: explicit Author never synthesizes missing approval and never erases a saved rejection
- Line 169: a stopped direct issue retains its ordinary resume meaning and an authored issue is never reset
- Line 204: explicit Author refuses completion/merge/rejection authority ${JSON.stringify(fields)}

### `test/roles/author/author-role.test.mjs`

- Line 101: an authored Gherkin answers the questions asked before it
- Line 109: a first Gherkin posts revision 1 and goes to implement
- Line 133: an unchanged Gherkin keeps its revision and returns to resumeStage
- Line 154: a changed Gherkin goes back to implement from any later stage
- Line 173: needs-info asks and stays at author, posting no Gherkin
- Line 185: a failed session stops with error, and a transient one defers
- Line 197: every stage runs its own role

### `test/roles/implementor/implementor-draft-save.test.mjs`

- Line 11: the writer observes durable PR state; a failed PR save launches no writer

### `test/roles/implementor/implementor-role.test.mjs`

- Line 70: a clean run works, pushes the draft with no sync or verify, and goes to review
- Line 100: a new push keeps a security rejection, which binds the exact merged result it rejected
- Line 108: the work task carries the facts: the Gherkin, the scope, the findings and the merge's return, no behaviour
- Line 142: after the code merged, Developer entry stops before any session or op
- Line 156: an issue with no Gherkin goes to the author and comes back to implement
- Line 166: cannot stops not-doable before any push
- Line 177: a transient session failure defers, and any other failure stops with error
- Line 193: a resolver's reply to the work task stops with error
- Line 203: a branch that changes nothing still goes to review, and says so
- Line 217: a branch whose existing change already does the Gherkin is pushed as it is, and sent to review
- Line 234: a failed op propagates as its OpsFailure, and a malformed reply fails
- Line 246: the Developer never syncs, verifies, readies, merges or completes

### `test/roles/merge/direct-merge-recovery.test.mjs`

- Line 82: ${name}, authorUsed=${authorUsed}: Developer entry refuses without any operation or session
- Line 114: an unrelated historical rejection does not forever block premerge direct work and remains content-scoped evidence
- Line 151: changed inputs during direct postmerge Security stop with original authorization and no next writer
- Line 184: direct completion input change stops without rewriting merge and clearance evidence, finish refusal=${refusedFinish}
- Line 216: a direct postmerge requirements plan holds instead of saving a Developer stage or clearing authorization
- Line 229: ordinary premerge direct requirements still return to Developer and legacy authored merged work still returns to Author

### `test/roles/merge/explicit-target-replay.test.mjs`

- Line 27: done replay with saved security still reestablishes graph/checks before completion
- Line 50: ${stage} replay honors durable exact security rejection before checks or models
- Line 73: own recovery refuses ${change} mismatch rather than inventing provenance or invoking checks
- Line 94: postmerge identity mismatch stops with receipt retained instead of reopening a writer
- Line 109: byHand observed during merge is never promoted to a fresh own receipt
- Line 127: external merged result needs independent postmerge hardening, not original H or codeMerged alone
- Line 141: independently hardened postmerge M retains external provenance and runs exact checks without merge
- Line 172: ${outcome} stops without an own receipt, repeat POST or security session
- Line 190: unreadable merged verification propagates without losing saved own receipt or running a writer
- Line 210: done replay check failure cannot reuse saved security to complete unchecked M

### `test/roles/merge/explicit-target-result.test.mjs`

- Line 25: uninterrupted own result checks M after premerge Security and saving truthful merge, before completion
- Line 80: ${mode} own ${failure} check failure preserves merged truth and stops without security/completion/writer
- Line 121: exact own recovery checks M even with cached verified M and preserves original-head vs merged provenance

### `test/roles/merge/merge-attempt-role.test.mjs`

- Line 39: saved successful response reconciles before ordinary approval or writers, then verifies M before read-only security
- Line 71: unconfirmed/external evidence cannot enter own processing or a writer: ${JSON.stringify(reply)}
- Line 89: durable exact security rejection with attempted/merged evidence never rerolls after lifting the stop

### `test/roles/merge/merge-done-code-only.test.mjs`

- Line 41: a code-only done completion rechecks M before reviewing missing security
- Line 80: a done completion rechecks M before reusing exact clearance

### `test/roles/merge/merge-role-candidate.test.mjs`

- Line 32: target movement during Security discards clearance and has zero merge effects
- Line 45: a finding returned while only the target moves is saved and cannot reroll after fresh target hardening
- Line 82: a returned finding with changed code still discards the obsolete subject
- Line 93: a returned finding with changed inputs still returns to requirements review
- Line 105: exact saved candidate clearance permits only one merge and no duplicate postmerge model pass
- Line 123: an old postmerge receipt naming the candidate never substitutes for premerge Security
- Line 139: unknown or stale retained target returns to hardening before any checks or session: ${JSON.stringify(target)}
- Line 154: target movement after saved Security reuse returns to hardening without a merge
- Line 167: a new target cannot reroll rejection of unchanged candidate content
- Line 208: candidate review refuses merged or uncertain provenance without preparation or a writer: ${JSON.stringify(evidence)}

### `test/roles/merge/merge-role-checks.test.mjs`

- Line 39: failing CI gets a Reviewer check-fix session, then its own verify, push and receipt
- Line 61: a fix session that can't fix the checks stops with check-fixes, pushing nothing
- Line 70: a failed local check at merge is fixed in the integration phase
- Line 95: CI decides: pending waits, none required stops, a moved head goes to review
- Line 113: failing CI and then failing checks get one integration fix session each before the push

### `test/roles/merge/merge-role-completion.test.mjs`

- Line 65: after a confirmed code merge, the merge commit is verified, reviewed for security and completed
- Line 102: a code merge needs a hardening of the merge commit, and GitHub's confirmation
- Line 118: a change with no PR and no code merge stops, merging nothing
- Line 128: a saved completion whose finish crashed rechecks M before finishing again
- Line 158: an older completion with no code merge finishes with no PR
- Line 176: a completion saved with a legacy wiki head and no security review of it stops for reconciliation, reviewing and finishing nothing
- Line 187: a completion is not finished on new inputs or a merge GitHub doesn't confirm
- Line 224: a completion the finish op refuses for new inputs goes to the author
- Line 230: a completion the finish op refuses for anything but new inputs stops, never done
- Line 243: a finish op reply outside its schema fails as an op, so the job stops instead of crashing
- Line 254: a merge receipt for another legacy wiki head cannot resume the own merge: it returns to review, never finishing

### `test/roles/merge/merge-role-integration.test.mjs`

- Line 46: a branch behind its base is rebased, checked, pushed and its receipt saved, with no model review
- Line 72: the next merge job refuses an integrated head until fresh hardening
- Line 89: a rebase conflict gets a Reviewer resolver session of the integration phase, counted once as a sync
- Line 121: integrations are allowed for exactly maxSyncs, then stop before rebasing or any session
- Line 147: a head that moved after the integration's push goes to review, with no receipt
- Line 162: a branch push that leaves another head than the verified one stops with no receipt or completion

### `test/roles/merge/merge-role-receipts.test.mjs`

- Line 22: own merge saves the original receipt, exact-M verification, security and completion separately
- Line 52: an own-result verify failure with ${checks.length} failed rows stops without a writer or completion

### `test/roles/merge/merge-role-replay.test.mjs`

- Line 43: an interrupted own merge resumes missing security with codeMerged ${String(codeMerged?.sha ?? null)}, no writer or second merge
- Line 78: an interrupted own merge reuses exact saved security approval and original integration authorization
- Line 97: an interrupted own merge with an exact rejection re-stops before recovery or another session
- Line 157: own-merge recovery refuses ${mismatch.name} without a session or finish
- Line 170: own-merge recovery requires an explicit authoritative PR head
- Line 183: new trusted inputs after the own merge return to Author instead of recovering the receipt
- Line 195: code that moves during the recovered security session discards it and never finishes

### `test/roles/merge/merge-role-security.test.mjs`

- Line 56: a finding in any category saves its receipt and stops with that category, never finishing
- Line 77: the same rejected revision stops again with no session, prepare or finish
- Line 95: a rejection of another revision is no receipt for this one: the merged result is reviewed afresh
- Line 110: a revision that moved during the review discards it: nothing is saved as a receipt or finished
- Line 124: inputs that changed during the review send the issue to the author, never finishing
- Line 135: a review prepared at another head than the merge commit stops with no session
- Line 146: a failed review stops with error and a transient one defers, neither finishing
- Line 161: a done completion with a saved rejection stops again, never finishing

### `test/roles/merge/merge-role.test.mjs`

- Line 58: a hardened revision receives Security clearance before its exact head merges and the issue completes
- Line 82: the security review is a fresh read-only Reviewer session over the exact candidate
- Line 106: the security comment keeps the key a pipeline with a wiki gave the same merged code, so a comment posted before the upgrade is edited, not repeated
- Line 114: nothing integrates or pushes after Security prepares the candidate
- Line 124: the Reviewer's own integration requires fresh hardening before merge
- Line 138: no authorization for the current revision goes to review without a mutation
- Line 159: inputs the Gherkin predates go to the author before anything merges
- Line 192: inputs that change after the checks hold the merge back
- Line 201: a head that changes after the checks goes to review, not to merge
- Line 211: a queued merge waits at merge, completing nothing
- Line 220: a PR still a draft is marked ready from the saved authorization, then waits for the next merge job
- Line 236: GitHub's refusal stops with merge-refused; a merged reply with no merge commit is an error
- Line 252: a merge of another head than the authorized one is never reviewed or completed as authorized
- Line 262: after its own merge, GitHub must confirm the merge commit before completion

### `test/roles/merge/merge-sync-continuation.test.mjs`

- Line 20: subsequent text stops get bounded sessions without restarting the code rebase
- Line 58: a later text stop cannot exceed the existing conflict-fix limit

### `test/roles/merge/merge-sync-retention.test.mjs`

- Line 21: evidence preparation failure does not claim a controlled retained conflict stop or erase a saved attempt
- Line 43: a failed attempt checkpoint cannot continue the rebase or launch another resolver
- Line 63: a retention request rejects an incompatible receipt: ${JSON.stringify(reply)}

### `test/roles/merge/merge-sync-session-outcomes.test.mjs`

- Line 13: ${outcome} before later picks that apply cleanly uses one session and one conflict attempt

### `test/roles/merge/merge-sync.test.mjs`

- Line 78: a conflict is resolved by a counted Reviewer integration session
- Line 105: rejected resolutions rebase afresh, up to exactly maxConflictFixes attempts
- Line 133: an issue out of conflict attempts stops before another resolver session
- Line 147: a transient resolver aborts the rebase and defers, counting nothing
- Line 162: cannot-fix is counted and goes through code finish classification; rejected work retries within the bound
- Line 187: a conflict reported with no stopped rebase stops with error
- Line 197: a failed resolver session aborts the rebase and stops with error, counting nothing
- Line 214: an abort that fails propagates its failure instead of deferring quietly

### `test/roles/merge/reviewed-target-merge-role.test.mjs`

- Line 10: target movement ${timing} returns to fresh review without an integration writer or mutation retry
- Line 49: a missing historical target is readable but cannot authorize a new merge or writer

### `test/roles/merge/security-policy-composition.test.mjs`

- Line 84: same-policy candidate clearance completes without another Security session
- Line 100: proven policy-moved candidate receives a separate read-only result observation
- Line 135: policy-moved result without original target provenance is refused
- Line 145: an unconfirmed result never enters policy re-observation
- Line 157: policy movement does not reroll a rejection in ${slot}
- Line 186: a second policy movement during result Security discards approval without looping
- Line 206: a policy movement during Security never discards a finding on unchanged content
- Line 233: missing historical policy remains unbound and cannot become candidate clearance

### `test/roles/reviewer-and-merge-role-calls-test-kit.test.mjs`

- Line 20: verify counts with extra reads before ${boundary}
- Line 33: checks before merge or after the security boundary do not count

### `test/roles/reviewer/reviewer-role-revision.test.mjs`

- Line 47: a head that moved after the push waits, saving and posting nothing
- Line 61: inputs that changed during hardening send the issue to the author, voiding any hardening
- Line 74: a Gherkin older than the inputs, or none, goes to the author before any session
- Line 115: after the code merged, hardening verifies the merge commit, pushes nothing and binds the merge commit
- Line 140: postmerge preparation of a different result refuses a writer and preserves merged provenance
- Line 155: a code merge GitHub doesn't confirm stops before any hardening
- Line 166: a failed session stops with error, and a transient one defers, saving nothing
- Line 181: an op reply of an unexpected shape is an error, not a hardening

### `test/roles/reviewer/reviewer-role.test.mjs`

- Line 62: hardening runs one Reviewer session, verifies, pushes, saves the hardened revision, then readies the PR and goes to merge
- Line 90: the hardening task carries the facts: kind, scope and Gherkin, no behaviour
- Line 103: the comment says only that hardening passed, never that anything was approved
- Line 113: a hardening saved for exactly this revision goes on to merge with no session
- Line 135: an integrated head needs a fresh hardening session even when linked to the earlier hardening
- Line 148: a hardening of an earlier revision is redone on the current one
- Line 155: a ready-pr that fails leaves the hardened revision saved, so the next job only readies the PR
- Line 164: cannot stops not-doable with nothing verified, pushed or saved
- Line 181: a failing check gets a hardening-phase fix session and the fixed head is the one pushed
- Line 208: a hardening timeout never verifies, checkpoints or readies the draft
- Line 220: a targeted-test reply cannot bypass the bounded deterministic check-fix gate
- Line 252: a push of anything but the verified head stops with error and saves nothing
- Line 264: a branch left with no code after hardening stops, never going to merge
- Line 275: hardening never syncs, merges, reviews security or completes

### `test/roles/verification-merged.test.mjs`

- Line 63: postmerge Developer entry requires reconciliation without changing retained work
- Line 86: verification after the merge checks exactly the merge commit
- Line 97: a verify of anything but the merge commit stops with error
- Line 111: checks failing on the merged code stop check-fixes with no fix session, naming them
- Line 129: a queued cannot reply cannot supersede postmerge Developer refusal

### `test/roles/verification.test.mjs`

- Line 67: a failing check gets a Reviewer fix session of the caller's phase, and the fixed head is the one verified
- Line 86: checks that keep failing get exactly maxCiFixes fix sessions, then stop
- Line 105: a fixer that can't fix the checks stops check-fixes at once, naming why
- Line 120: a transient fix session defers with nothing counted or saved
- Line 134: verify is the verdict, whatever the session says
- Line 147: failing CI gets the first fix session before any verify, then verify decides
- Line 161: failing CI with no check-fix attempt allowed stops at once, with no session

### `test/security-clearance.test.mjs`

- Line 39: only exact candidate hardening, checks and premerge Security clear the observed target
- Line 88: historical merged-result clearance never supplies premerge permission
- Line 102: candidate clearance reaches completion only through the saved own result and original authorization
- Line 123: a candidate receipt cannot replace retained hardening target: ${JSON.stringify(target)}
- Line 147: fresh configured repository, literal branch and advertised target must all match the receipt
- Line 181: a same-subject result rejection blocks direct premerge authorization
- Line 192: policy movement does not bypass a same-subject result rejection
- Line 208: a result rejection of different code does not block cleared candidate authorization
- Line 218: a null result finding does not block cleared candidate authorization

### `test/security-receipt.test.mjs`

- Line 38: candidate phase and shared target survive strict saved-authority parsing
- Line 42: phase-absent historical receipts stay readable without inventing target authority
- Line 63: malformed paired Security provenance refuses saved write authority: ${JSON.stringify(security)}

### `test/security-rejection.test.mjs`

- Line 25: a policy change cannot reroll rejection of unchanged code and trusted inputs: ${policy}
- Line 50: a different Security subject does not inherit rejection: ${JSON.stringify(revision)}
- Line 55: absent and null legacy wiki retain the same Security rejection

### `test/security-result-receipt.test.mjs`

- Line 40: result observation parses without a candidate phase
- Line 44: legacy absent and explicit null result slots are equivalent without adding a key
- Line 61: invalid result observation refuses write authority: ${JSON.stringify(receipt)}

### `test/state-approval-chain.test.mjs`

- Line 42: a new state has no hardening, no integration receipt and no security review
- Line 50: a version 2 state saved before hardened, integration and security existed reads them as null and authorizes nothing
- Line 74: the authorized revision is the hardened one when nothing integrated it, whatever the review verdict
- Line 82: the Reviewer's own integration does not authorize changed code and keeps the hardened one
- Line 98: a receipt bound to another revision than the hardened one authorizes nothing new
- Line 117: a receipt that changes the trusted inputs reads as none
- Line 130: a security review saves its exact revision and its finding, or none
- Line 145: a malformed hardened, integration or security field reads as null and keeps the rest
- Line 174: a merge authorization holds only for the code, legacy wiki and inputs revision hardened

### `test/state-legacy.test.mjs`

- Line 61: a legacy state past the spec goes to the author, then implement
- Line 81: triage, spec and no stage go to the author alone
- Line 89: stopped, done and publish keep their meaning
- Line 107: a version 2 state reads back as saved, and a bad field as its default
- Line 123: lifting a stop resumes the stage that stopped with its counts reset
- Line 137: a launch record whose session pushed to the wiki, written while the pipeline had one, still parses with its pushes
- Line 184: a state saved while the pipeline had a wiki parses with its receipts, dropping only the flows' wiki flag
- Line 200: a revision saved with a null wiki head is the same revision as one with none, so its authorization still holds
- Line 211: malformed checkpoints never make a legacy state unreadable

## Second pass

On 2026-10-24, before #191 landed, an audit of the surviving tests found ten pipeline cases that still called a module directly with no real dependency. Autumn also asked for workflow-dash's direct-call tests to go in the same change. Cases inside the fake-gh suites stay as the owner manifest protects them, including direct calls in `trusted-inputs`, `github-login`, `credentials` and `report/report-usage`.

### Converted to a real dependency

- `test/job/git-review.test.mjs`: the refused-subcommand, dangerous-option and unsafe-mode matrices now query the real review tool against a real repository. Each case checks the refusal and that the repository is unchanged. Allowing `fetch` or `--output` in the policy fails them.
- `test/project-policy-boundary.test.mjs`: the unknown-key, duplicate-member and separate-scope cases now commit the document as `.issue-pipeline.json`, pin that commit and load the operator config. Removing the duplicate-field refusal fails them.
- `test/job/runtime-policy.test.mjs`: the native-window case now launches sessions through the fake pi. The `:high` suffix and a 300,000-token window set the reserve, and a missing window, an impossible window and an unknown model refuse before pi starts. Removing the impossible-window refusal fails it.
- `test/job/runtime-history.test.mjs`, line 45: replaced by a `--print-boundary` job test in `job/job-boundary.test.mjs` that checks the declared credential variable, every model role and its compaction policy, with no secret in the output. Adding a credential variable fails it.

### Removed

- `test/job/job-dropped.test.mjs`, line 153: the dropped notice names the job, the code checkout and the run directory, and no local path. Its `repo/` and local-path assertions move into the SIGTERM job test.
- `test/job/job-dropped.test.mjs`, line 161: a run counts as stopped for a signal or a stopped job line, and for nothing else. Real jobs still cover the stop, next and SIGTERM ends, but not the ask, wait, deferred, unclaimed or SIGINT ends.
- From the runtime-policy case: the refusal of a compaction target below recent context in `runtime`, and the direct `stateRefusal` result. A successful launch with a 300,000-token window now covers the latter.

### Workflow-dash

The kept tests read real fixture files and temporary directories, drive `DashboardRuntime` through its configuration file and watchers, or load the extension entrypoint with a fake Pi host. 36 static declarations go, leaving 12 (16 at runtime, from 108). `theme-fixtures.ts`, `tool-test-kit.ts` and the unused `makeBuddy` and `viewFixture` helpers go with them. The sole direct assertions lost are TUI rendering and width fitting in both themes; read-tool contracts, output caps and inactive refusals; record schemas; process, capacity and gate observations; request templates and instruction cancellation; labels, time and configuration aliases; and opt-in gating.

Each bullet names an original path under `apps/workflow-dash/` and the removed cases, with their original line numbers.

- `test/buddy-requests.test.ts`: line 6, supervisor requests come from unmatched contacts; progress is not pending
- `test/data.test.ts`: line 83, configuration expands home and rejects bad repo names; credentials denied
- `test/domain.test.ts`: line 32, buddy configuration accepts both older names with canonical string precedence; line 55, legacy delivery coverage never fabricates a current task or a passing result; line 69, account observations validate metadata without inferring a buddy from its task; line 114, unknown process observations cannot imply success, completion or available capacity
- `test/language.test.ts`: line 56, canonical labels do not rewrite recorded launch keys or source stages; line 86, buddyRuns config wins over the deprecated operators key and both expand home; line 135, request templates preserve checkpoints, retry linkage and resource holds; line 193, ${name}: canonical ${pane.name} pane renders at narrow and wide widths; line 217, ${name}: mapped task labels remain distinct from source records
- `test/legacy-capacity.test.ts`: line 6, legacy capacity distinguishes slot groups, ignores dead runs and reports pb-web scope
- `test/lifecycle.test.ts`: line 53, opt-in gating is strict and mode-specific
- `test/messages.test.ts`: line 21, ${name} instructions never send; line 36, shutdown during editing prevents a late submitted instruction; line 61, edited text uses idle=${idle} delivery without template expansion; line 90, all required templates omit issue titles, thread text and buddy output
- `test/observability.test.ts`: line 55, reviewer gate requires a currently open bash gate call; completed calls disappear; line 98, process evidence must name a web runner AND a PB work path, with boundary
- `test/presentation.test.ts`: line 20, ${name}: progress thresholds retain their colors; line 30, ${name}: version changes render and unknown requests remain silent
- `test/process-observations.test.ts`: line 6, process observations preserve denied and missing evidence as unknown
- `test/render.test.ts`: line 81, ${themeName}: ${count} workflow runs hold=${hold}, all panes fit ${width}
- `test/source-records.test.ts`: line 11, legacy nullable observations retain source identities and recorded nulls; line 35, invalid workflow and buddy shapes fail their source boundary; line 47, JSONL and session readers ignore primitive, partial and non-message records; line 68, unidentified gate calls and unrelated contacts cannot establish observations
- `test/time.test.ts`: line 29, elapsed limits and warning threshold; line 38, consecutive launch deltas, job stages and model/tool message deltas
- `test/tools.test.ts`: line 26, canonical tools expose identities and labels without rewriting source keys; line 50, deprecated tool names preserve their prior JSON contract; line 97, uncertain runs do not imply activity, completion or a current task; line 120, native SDK registration receives every read-only tool; line 137, missing workflow runs report a bounded-reader failure; line 147, ${name}: output is capped at 12 KB; line 159, ${name}: inactive tools refuse reads before refresh
