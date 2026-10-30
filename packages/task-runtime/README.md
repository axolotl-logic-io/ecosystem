# Task runtime

`@ecosystem/task-runtime` owns shared execution services. It imports no
applications, reads no buddy files and discovers no pipeline root. Hosts supply
resolved settings, resource locations and operations that close over credentials.
Tasks receive only their task-specific capabilities.

## Ownership and dependency direction

| Layer | Owns |
| --- | --- |
| `tasks/*` | Domain inputs, prompts, reply schemas and decisions |
| `packages/task-framework` | Invocation validation, domain outcomes, cancellation and finalization |
| `packages/task-runtime` | Checkouts, model processes, native policy verification, commit/push guards, trusted policy reads, recovery artifacts and issue adapters |
| Application hosts | Buddy/config reads, verified identities, credential provisioning, installed resource paths and process startup |

Applications and tasks may import packages. Packages never import applications.
Task definitions do not import application adapters or receive credential maps.
A host translates its private layout once; public service inputs name a repository,
a destination, trusted resources or a capability rather than a pipeline root.
The issue-pipeline adapters remain operational during migration. They resolve
legacy configuration into these service inputs without changing installed CLIs.

## Checkout and recovery services

`checkout` exports `openBaseCheckout(source, directory, access)` and
`openJobCheckout(spec, access)`. A source names a mirror, origin URL and base
branch. A writable spec also names its private directories, branch and commit
identity. `GitAccess` supplies command-scoped Git operations and a mirror lock.
The lock serializes metadata updates; it grants no issue ownership. Checkout
creation initializes submodules, pins read-only access to a detached base and
refuses to overwrite retained writable work. The host owns read-only cleanup.

`job/checkout-close` exports `closeJobCheckout(destination, job, push, access)`.
The destination is an artifact directory plus repository/issue identity. The
service owns patch, manifest and bundle paths inside that directory. It saves
staged and working snapshots and verifies local-history bundles before resetting
or removing work. Failed preparation retains the checkout and index. Failed
publication retains the checkout and prepared artifacts. Recovery never replays
patches, applies bundles or pushes automatically without the supplied authority.

`publish-checkout` exports `publishCheckout(checkout, authority)`. It refuses
unresolved merges, dirty work, missing expected ancestry and invalid diffs before
calling the host's push operation. Stop checks guard both entry and the remote
effect. GitHub exact-head review/merge checks stay with their issue operations;
this extraction does not replace those checks with local Git ancestry.

## Model execution

`job/launch` exports `runSession(launch, hooks, resources)`. Resources explicitly
name the trusted agent directory, structured-output extension, commit extension
and parent HOME. Hooks supply observation callbacks, session destinations and the
host-provisioned model environment. The native runtime HOME and provider extension
must already be resolved paths. No service expands buddy configuration or finds
an installed runtime implicitly.

`model-environment` exports `modelEnvironment(environment, hiddenNames)`. Hosts
use it to remove GitHub/database credentials, declared private token names,
inherited Git configuration and inherited commit scope. Only a bound writing
session receives its own commit scope. Read-only sessions retain only read tools,
even when their agent definition also names editing tools.

The runtime preserves per-session subprocesses, process-group cancellation,
structured replies, pinned prompt bytes, native runtime version and provider
checks, isolated generated settings and correlated pre-prompt verification.
A committing session's control socket validates its invocation binding before a
push. `job/pipeline-commit` owns commit argument/path validation. Configuration
isolation does not create an OS or same-user filesystem sandbox.

## Trusted policy

`project-policy` exports `readTrustedProjectSettings(source, expectedOrigin)`.
The source is an absolute repository path and full immutable commit SHA. The
service verifies the origin, commit object, regular-file mode, document size,
UTF-8 and strict schema. It reads Git objects with replacement objects disabled;
candidate working-tree settings never activate policy. Existing digest/binding
operations remain available to compatibility callers and keep their provenance
and effective-settings binding.

## Issue and artifact adapters

`issue/issue-github` exports `IssueGitHub`. Its actor supplies a verified account
and a transport with reads, writes, pagination, redaction and failure handling.
Credentials stay inside the host's transport closures. Writes check `agents:stop`;
final reporting can explicitly use the ending path after cancellation.

`issue/claims` preserves start-label arbitration and running-label reconciliation.
`issue/recovery` reads authoritative branch, PR, review, check and earlier-comment
state. `issue/issue-file` filters trusted people and authenticated task comments.
`issue/artifacts` exports `issueArtifacts(github, options)` for logical artifact
publication. The host declares which artifact kinds update an existing comment
and which append fresh comments. Claim provenance and hidden marker formats stay
inside the adapter; tasks see neither paths nor comment ids.

Gherkin uses these services through its existing host-provisioned
`openRepository`, `runModel` and artifact capabilities. Its task contract stays in
[tasks/gherkin](../../tasks/gherkin/README.md).

## Launcher services

`credentials` and `trusted-file` retain operator-file checks. `issue/transport`,
`issue/github-read`, `issue/github-observation` and `issue/wire` provide redacted
GitHub calls, bounded read retries, strict paginated observations and wire
normalization. Observation readers supply an explicit credential environment or
credential closure; these modules import no applications or buddy settings.

`issue/invocation` defines the strict version 1 issue-host invocation and its
separate credential channel. The [launcher](../../apps/launcher/README.md) owns
buddy configuration and provisions these inputs to task bootstraps. Domain
tasks continue to receive their own validated inputs and task-specific capabilities.

## Validation and activation

`npm run check --workspace @ecosystem/task-runtime` runs types, lint and behavior
tests with real local Git and files. Both root gates include this workspace.
The full pipeline gate also exercises these public services through built CLIs,
fake GitHub and fake models, including claims, stops, credential isolation,
publication and recovery.

A source merge changes no running installation. Follow the pipeline's
[install and restart procedure](../../docs/reference/operations.md#install-a-release)
to activate the release, preserving retained work and private configuration.
