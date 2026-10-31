# Safe Refactor

Safe Refactor is an explicit Developer task, performed by Hippy. The caller supplies requirements, an exact source commit, a reviewed policy and a bounded write scope. The model reads project text and requests named refactoring operations. It can supply bounded type syntax only to named type operations. It cannot edit files, supply executable replacement source, run transforms or execute commands.

This implementation is standalone. Existing job dispatch, the retained orchestrator, general writer tools, accounts and delivery authority are unchanged. Landing this source does not install or activate it.

## Behavior contract

The initial catalog supports JavaScript and TypeScript under `js-values-effects-v1`. Within its preconditions, an operation preserves ordinary returned and thrown values, state changes and effect order. The caller must establish that the requested behavior does not depend on source text, local identifier spellings, function-source reflection, call-stack inspection, debugger details, timing or resource consumption. If those observations matter, or their relevance is unknown, use the non-mutating check and defer mutation.

The assignment must explicitly select this contract. The tool does not silently downgrade a stronger preservation requirement. These exclusions are limitations, not proof that arbitrary JavaScript is equivalent. TypeScript's refactor availability, passing diagnostics and the model's explanation do not establish general behavior preservation.

The engine checks operation-specific preconditions independently of the model. A rejected operation stays rejected: there is no editor, shell, patch or arbitrary-code fallback. Downstream Hardening must still verify the requirements and meaningful design improvement. Independent Security and Land keep their existing prerequisites and authority.

## Operation catalog

| Operation | Scope and limits |
| --- | --- |
| `read` | Paginated UTF-8 source, Markdown and configuration text inside the project. Known credential and runtime paths are protected. |
| `inspect` | Paginated assigned source, qualified declaration names, return-expression ranges, source hash and catalog limits. Inspection does not establish applicability or authorization. |
| `check` | Current or retained baseline evidence for default Biome checks, the explicit metric profile and one TypeScript project. Tool responses are paginated; the explicit CLI `check` returns full evidence. No autofix, build, test command or model call. |
| `rename-symbol` | A simple function-local primitive variable or parameter. The TypeScript language service computes references and preserves shorthand property names. Parameter properties, decorated parameters, implicit `arguments` bindings, prototype-sensitive `__proto__` shorthand, dynamic scope, ambiguous targets, capture and an already-occurring new name refuse. Public symbols, files and APIs cannot be renamed. |
| `extract-function` | One complete pure primitive return expression directly in a synchronous named function body. The TypeScript language service extracts a non-escaping inner helper with closed-over inputs and no parameters. Whole-function forwarding, block-local returns, implicit `arguments`, calls, property access, writes, asynchronous work and unsupported syntax refuse. |
| `introduce-type` | Create a top-level alias or interface whose name is `target.symbol`. Supply exactly one type-only `declaration`. The new name must not capture an existing project identifier. Optional `annotations` update uses atomically in the same file. |
| `modify-type` | Replace one uniquely identified alias or interface with a parsed `declaration` of the same name. Generic declarations and alias/interface conversion are allowed when all checks pass. Optional `annotations` can change its uses in the same file. |
| `remove-type` | Remove one uniquely identified alias or interface. Optional `annotations` can replace its uses atomically; remaining project consumers must still typecheck. |
| `set-type-annotation` | Introduce or modify a variable, parameter, property or named function/method return annotation with one `type` expression. Return predicates are supported. Use `slot: "return"` for a variable or property whose initializer is a function; adding a return annotation requires an existing parenthesized parameter list. |
| `remove-type-annotation` | Remove an explicit annotation from the same supported targets. Inference must leave project checks and emitted JavaScript unchanged. |

An extraction names a cohesive calculation; it is not a general function/file decomposition tool. An inner helper can leave enclosing-function and file-length findings unchanged or increase them. Defer findings that need unsupported structural changes rather than add arbitrary helpers to improve scores. Names and rationales still need independent design review.

A Target describes a program element with `file` and its qualified `symbol`, such as `total.amount`. It is distinct from the workflow's target state. The engine resolves it against the assigned source, requires one declaration and checks the separate `source` SHA-256 before mutation. Extraction also requires the exact return-expression range. Character offsets are zero-based UTF-16 code-unit offsets; hashes cover UTF-8 file contents.

A library-provided rename is not always preserving: expanding `{ __proto__ }` into `{ __proto__: renamed }` changes an own data property into prototype-setting syntax. The adapter refuses this case before writes. A real module-execution regression test reproduced the change before the guard was added. Implicit `arguments` also needs a refusal because a new helper has its own binding.

The rename/extraction backend uses TypeScript's `getRenameInfo`, `findRenameLocations`, `getApplicableRefactors` and `getEditsForRefactor`. Type operations use the compiler's parser and printer rather than a general source replacement.

The build includes the compiler package under `vendor/node_modules/` beside the programs. This keeps it in the protected dependency namespace, including when the build lives inside the target checkout. Its inputs retain freshness hashes; they do not substitute for source revision inputs. Installed tools do not rely on a global TypeScript installation.

The adapter does not expose arbitrary jscodeshift transforms or reimplement their transformation mechanics. See the [TypeScript language-service API](https://github.com/microsoft/TypeScript/wiki/Using-the-Language-Service-API).

## Type-only edits

Named-type operations accept a single alias or interface declaration, including generic parameters and interface heritage. Annotation operations accept one type expression, or a return predicate in a return position. Comments, compiler directives, extra statements, classes and enums refuse. Comment checks use parser-established node and token boundaries, including template-literal continuations; the type printer also removes comments as a second safeguard. Source containing typecheck suppression directives also refuses type operations. Removing a named type with leading comments refuses rather than leaving its comments or directives attached to the next declaration. Only assigned TypeScript implementation files can change; JavaScript and declaration files remain outside this catalog's type edits.

The engine formats each projected type edit through the trusted Biome formatter, without lint autofixes. Before opening a source file for writing, it checks the projected files with the unchanged consulted project policies in a private external projection. Each requested file must be processed, and skipped or incomplete evidence refuses. Biome's stdin mode is used only for formatting, never as lint evidence. Projects whose checker needs additional unmirrored inputs may defer rather than accept weaker evidence.

Project-wide TypeScript diagnostics must pass on the complete projected edit. The engine also captures whole-project JavaScript emission in memory before and after the edit, retaining runtime-relevant compiler settings while enabling JavaScript emission and disabling declaration, source-map and incremental-build outputs. The emission probe must resolve and typecheck the same source graph as the checked project; unresolved imports cannot stand in for real type information. It compares canonical JavaScript with comments and formatting removed; module markers, value imports, helpers and decorator metadata must remain unchanged, including in unassigned project consumers. An unavailable or changed emission refuses before any source write or application checkpoint. This probe executes no emitted code and does not replace the downstream build.

These operations preserve the selected JavaScript values/effects contract, not every external consumer's TypeScript API. A changed public type can compile in this project but break consumers outside it. Review that compatibility separately. Ambiguous declarations, unsupported syntax and failed projected checks have no editor or arbitrary-code fallback.

Each optional `annotations` entry names a qualified `symbol` in the same file and supplies a `type`, or `null` to remove its annotation. Its optional `slot` defaults to `"annotation"`; `"return"` selects a function initializer's return. Up to 32 entries can accompany a named-type operation. The complete edit is checked atomically, avoiding temporarily unused or missing types under strict compiler rules.

## Check evidence

The root `biome.safe-refactor.jsonc` sets explicit design budgets:

- File length: 300 lines.
- Function length: 50 lines.
- Cognitive complexity: 15.

Blank lines count; immediately invoked functions do not receive a length exemption. Biome defines the counting semantics. The default profile remains unchanged. Metric findings are design signals, not a requirement for a clean score. Do not suppress rules, raise thresholds, split arbitrarily, add forwarding wrappers or relocate complexity solely to evade a budget.

Each check returns separate `default`, `metrics` and `types` verdicts, diagnostic identities, assigned-source hashes, consulted-input hashes, policy hash, TypeScript version, project path, and Biome launcher hash/version and Node.js version. The adapter requires Biome 2.5.15. Incomplete, skipped, unreadable, unavailable or unsupported checker evidence is unknown, never a clean result. Default and metric commands use fixed arguments, an empty environment, a two-minute timeout and a 16 MiB output limit.

Default and metric checks cover the root scope selected by Biome configuration, with assigned paths also requested explicitly. Type diagnostics cover the supplied TypeScript project and its resolved inputs, with `noEmit`, `allowJs` and `checkJs` enabled. This is not a claim that every project in a monorepo was typechecked. Project references, package/external Biome configuration and custom build/typecheck adapters are deferred.

Hashes identify the assigned files and consulted compiler/policy/glossary inputs, not every file in another project's Biome scope. A check on a changed tree is an observation, not proof that all checked bytes match the caller's commit. Exclusively allocated source and the caller's eventual revision binding remain necessary.

Tool `check` requests accept `offset` and `limit` in characters and `baseline: true` to revisit immutable original evidence after an edit or compaction. Responses always include verdict/count summaries, a hash for comparing pages, total length and the requested JSON slice. Current and baseline evidence retain full external artifacts. The model must read later pages rather than invent omitted findings; default pages are 12,000 characters and the maximum is 20,000.

Source, consulted inputs, configuration-file inventories and project file sets must remain fresh. The engine tracks local Biome `extends`, ignore files, compiler inputs and the glossary when present. Mutation requires a clear non-metric/type baseline and known checks. A post-application failure remains visible in evidence and blocks successful task reporting; the tool never weakens checks to clear it.

The evidence explicitly marks build, Hardening, Security and Land as `notRun`. The caller must run the applicable build and existing downstream checks on the resulting revision. Check evidence is not a signed workflow Result or Receipt.

## Caller assignment

The caller, not the model, supplies the assignment. Assignment, operation and proposal objects reject unknown fields. Keep the request and artifacts outside the target checkout.

```json
{
  "root": "/absolute/canonical/checkout",
  "revision": "COMMIT_SHA",
  "policy": "PROFILE_SHA256",
  "behavior": "js-values-effects-v1",
  "requirements": "Preserve public behavior and clarify the subtotal calculation.",
  "prompt": "Improve the assigned design using the glossary and explain deferred findings.",
  "project": "apps/issue-host/tsconfig.json",
  "files": ["apps/issue-host/src/example.ts"],
  "biome": "/absolute/ecosystem/node_modules/@biomejs/biome/bin/biome",
  "profile": "biome.safe-refactor.jsonc",
  "model": "openai/gpt-6.1-sol",
  "runtime": {}
}
```

Replace `COMMIT_SHA` with the full assigned Git object ID and `PROFILE_SHA256` with the lowercase SHA-256 of the profile bytes. Replace the example paths and text with the authorized project, existing source and requirements. `root` must be an absolute canonical filesystem path. `files` contains 1–32 unique implementation files in the TypeScript project, not declarations or policy files. The caller must trust the absolute Biome JavaScript launcher: the adapter executes it with Node.js, not a shell or arbitrary command string.

The empty runtime object is sufficient for a non-mutating check. A model run requires the separately provisioned, approved [native runtime and identity configuration](runtime.md). This feature provisions no provider, credentials or accounts. The model receives no general `read`, `edit`, `write`, `bash`, commit, subagent or arbitrary-code tool. The native extension activates only `safe_refactor` and `safe_refactor_finish`, and blocks other tool calls.

Before a task or standalone mutation, read-only Git verifies the assigned HEAD, a clean index/worktree and no untracked non-ignored files. It also compares the actual bytes of assigned sources and consulted in-project source/config/glossary inputs with the assigned tree. Ignored generated compiler inputs cannot substitute for tracked revision inputs. The existing [read-only Git boundary](runtime.md) supports plain clones, not linked worktrees, initialized submodules or alternate object stores. Paths that Git quotes, including some non-ASCII filenames, currently defer exact-tree validation.

Project text is limited to 1 MiB per file; compiler inputs are limited to 4 MiB. Inputs must be canonical, regular, singly-linked UTF-8 files. Symlinked workspace/package inputs and external non-package compiler inputs need separate adapters. The caller must supply a reviewed, tracked metric profile in another target repository; the model cannot create or modify one.

## Invoke the interface

To build the source programs without installation, run from the repository root:

```bash
npm run build --workspace @ecosystem/issue-host
```

To collect non-mutating codebase evidence, run:

```bash
node "$ECOSYSTEM_INSTALL_ROOT/safe-refactor.mjs" check --request REQUEST_JSON
```

`REQUEST_JSON` is the external assignment file. This command makes no model call and may inspect a changed working tree. Exit code 1 means a finding, unknown evidence or a refused request; inspect the structured evidence or error instead of interpreting it as a metric waiver.

After separate operator authorization, runtime provisioning and exclusive checkout allocation, the standalone task interface is:

```bash
node "$ECOSYSTEM_INSTALL_ROOT/safe-refactor.mjs" run --request REQUEST_JSON --artifacts ARTIFACT_PARENT
```

`ARTIFACT_PARENT` is an existing external directory. The launcher creates a fresh run directory and session, retains the existing runtime preflight and enforces a one-hour session deadline. No existing job or caller entry point invokes this task automatically.

For an authorized single-operation diagnostic, the interface is:

```bash
node "$ECOSYSTEM_INSTALL_ROOT/safe-refactor.mjs" operation --request REQUEST_JSON --artifacts OPERATION_ARTIFACTS --operation OPERATION_JSON
```

`OPERATION_ARTIFACTS` is an existing external directory. `OPERATION_JSON` contains one catalog request, for example:

```json
{
  "operation": "rename-symbol",
  "target": { "file": "src/totals.ts", "symbol": "total.amount" },
  "source": "SOURCE_SHA256",
  "name": "subtotal",
  "rationale": "Name the value before its domain adjustment."
}
```

Replace `SOURCE_SHA256` with the hash returned by inspection and use an assigned file and unique declaration. There is no general replacement-text argument. Type operations accept only their parsed type-specific fields. To introduce a named type and replace an inline annotation in the same checked edit:

```json
{
  "operation": "introduce-type",
  "target": { "file": "src/totals.ts", "symbol": "Count" },
  "source": "SOURCE_SHA256",
  "declaration": "type Count = number;",
  "annotations": [{ "symbol": "total.amount", "type": "Count" }],
  "rationale": "Name the counter's domain value without changing its calculation."
}
```

To change a declaration, use `modify-type` with its existing qualified symbol and a declaration of the same name. To remove `Count` and restore an inline parameter type, use `remove-type` with `annotations: [{ "symbol": "total.amount", "type": "number" }]`. To change a return annotation directly, use `set-type-annotation` on the named function with `type: "number"`; for a function-valued variable, also set `slot: "return"`. Every operation needs the current source hash from inspection.

The standalone mutation command rechecks the clean assigned revision on every invocation; it is not a shortcut to continue modifying an already-changed checkout. A task session owns its sequence of source-bound operations. For `operation`, exit code 0 means the request returned evidence, not that every evidence verdict passed.

## Artifacts and recovery

The run directory contains assignment, baseline, provenance, session, event, exit, after-check, proposal and outcome records. Reports retain baseline/after verdicts and counts, distinguish observed regressions from unknown comparisons, and verify unchanged consulted-input/checker identities. Failed-to-failed comparisons are unknown rather than assertions that an existing failure did not regress.

The model must explain the design and give exactly one `improved`, `resolved` or `deferred` disposition, with a reason, for every baseline metric diagnostic ID. Those dispositions are proposals, not verified design or preservation claims. A run can end `reported` while known metric findings remain. Missing proposals, pending writes, unavailable baseline/after evidence, changed input identity or failing non-metric/type checks hold the run. Reports always retain `needsHardening: true` and `deliveryAuthority: false`.

Before writing, the engine validates engine-computed edits and persists `pending.json` with operation, revision, policy and complete before/after contents. It flushes that checkpoint and its directory before source writes. Complete source writes are flushed before the checkpoint becomes `UUID.applied.json`; separate check evidence follows. This is durable write-ahead evidence, not a transactional multi-file commit.

To reconcile a pending or uncertain application:

1. Stop the run and retain its checkout and artifacts.
2. Inspect `pending.json`, application/check records and actual source read-only.
3. Establish which writes occurred and whether the source matches before, after or a partial state.
4. Obtain explicit caller authorization for recovery and a newly bound revision before another mutation.

Do not delete a pending checkpoint, automatically replay an operation or assume that a lost response means no write occurred. Post-write checks can also fail after source changed; retain that fact rather than claim rollback. The task never commits, pushes, approves, lands or signs authoritative workflow state. A caller that preserves the change must create/bind its new revision through the ordinary authorized path and obtain fresh downstream results.

## Enforcement limits

The caller must exclusively allocate the checkout and trust the launcher, extensions, dependencies and checker. Path, link, hash and descriptor checks protect the constrained interface. They are not an operating-system sandbox against a competing same-user process, malicious trusted extension, universal credential discovery or filesystem races. Known protected paths do not identify every possible secret in arbitrary project JSON. Allocate source-only project text and use separately enforced host isolation where required.

The restricted tool API, not prompt compliance, prevents model-directed general writes and command execution. It does not certify the quality of a selected name, calculation boundary or metric disposition. There is no scheduler integration, shared authenticated Result/Receipt adapter, automatic retry, installation or activation in this slice.

## Verification

`test/component-integration/safe-refactor/type-operations.test.ts` exercises type edits through real files, TypeScript and Biome. It covers atomic named-type uses, annotations, generic declarations, runtime behavior, executable injection, failed or skipped projected checks, source/input freshness and pending-write holds. It also checks the existing rename/extraction operations, NodeNext module format and package export-map resolution. It also proves refusal when a type-only export changes a script's module emission or an alias changes decorator metadata in an unassigned consumer.

`test/system/safe-refactor-types.test.ts` exercises the built CLI's exact-revision path and the restricted extension's generated schema, execution and tool boundary. These tests use disposable projects, not models or live credentials.

Run the focused tests from `apps/issue-host/` after building:

```bash
npm run build
node --test --test-timeout=180000 \
  test/component-integration/safe-refactor/type-operations.test.ts \
  test/system/safe-refactor-types.test.ts
```

The ordinary full gate remains `npm run check:full`. Source delivery runs no model and installs or activates nothing.
