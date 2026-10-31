# Pipeline-owned native runtime

## Contract and supported launch

All five model-session paths (Gherkin, Implement's writing session, its fresh hardening session, Verify's read-only review with its Security, and Fix) use the same versioned policy: native automatic compaction **enabled**, target **175000** tokens, recent-history setting **30000** tokens. This is native context management, not a spending/token budget. Pi's trigger is strictly `contextTokens > contextWindow - reserveTokens`, evaluated at its native turn/tool boundaries; it is not a hard cap checked at every token. Recent retention follows native message/turn boundaries and is approximate, not an exact token slicing guarantee.

The supported adapter is **native Pi 1.4.0 + trusted installed pi-cliproxyapi 0.4.3**. It launches the existing `pi` executable with:

```text
--mode rpc --print --offline --no-approve --no-extensions
-e builtin:codemode -nc -ns -np --no-themes
--model <configured model> --session <existing pipeline session path>
-e <trusted provider index.ts> …existing pipeline extensions/tools/prompts/schema…
```

Explicit RPC wins over `--print` in Pi 1.4.0. `--print` is necessary specifically because CLIProxy 0.4.3 otherwise treats RPC as interactive and can do startup/background discovery and quota requests. In that provider's existing headless branch it uses only its provisioned discovery cache and does not refresh it. Native `--offline` alone does **not** make provider extensions offline, and neither flag prevents later authorized generation requests. This is a narrowly version-checked launch adapter, not a general CLI compatibility promise. Upgrades require renewed source/protocol review and local proof, not removal of the version check or a fallback.

Each session gets a new private `PI_CODING_AGENT_DIR` beside its existing session JSONL. Only pipeline-generated settings live there; no personal settings, model overrides, models.json, auth.json, packages, extensions, skills, prompt templates or themes are copied. Project settings/trust and resource discovery are disabled. Explicit session extensions and the structured-output/commit extensions are retained; commit tools/scopes and read-only tool ceilings still come from the session authority. The native session JSONL and normal timeout, abort, steer, structured-output, error and usage lifecycles remain in place. A steer arriving before verification is refused; abort and process-group stop remain available. No token watcher, kill/restart, second session, replacement architecture, model/provider/CLI fallback or custom compaction hook implements this policy.

For `openai/gpt-6.1-sol` the expected native window is **272000**, so generated settings are:

```json
{ "compaction": { "enabled": true, "reserveTokens": 97000, "keepRecentTokens": 30000 } }
```

`runtime.modelContextWindows` declares expectations; it does **not** override or register model metadata. The supported provisioned profile is deliberately narrow: **OpenAI builtin registration through a distinct CLIProxy endpoint**, not arbitrary custom providers or direct-native endpoints. Other provider/profile shapes refuse pending separate review, never fall back. A different supported OpenAI model requires its own reviewed `provider/model` entry. Thinking suffixes such as `:high` use that same model entry. Missing expectations or windows at/below 175000 refuse before launch. Changed valid windows derive a different reserve. Never fabricate a models.json, CLIProxy contextWindow override or discovery-cache window just to pass this check. CLIProxy can prefer Pi's built-in catalogue over proxy metadata; review the **actual native selected model**, not only the proxy's advertised window.

Before the first prompt, native RPC must answer the correlated `get_state` with success, the exact configured provider/id/window/endpoint and `autoCompactionEnabled: true`. The generated settings and provisioned provider config/cache files are hashed again at that point. Invalid/missing data, changed settings, model drift or a host-provider fallback closes stdin and fails the launch without a prompt. The `runtime_policy` log record contains verified policy numbers, versions and SHA-256 settings/provider-profile/cache provenance, never native headers or credential values. Native get_state does not expose token settings: their evidence is the isolated generated file, its checked hash and the version-pinned native SettingsManager contract, not a fictitious RPC token-settings API. Compaction adds a summary/retained context to **the same native session**; native raw history stays append-only.

## Declared toolchain, isolated model configuration

`runtime.toolchainEnv` is the non-secret toolchain declaration in the operator's repository config. It accepts only `PATH`, `MISE_DATA_DIR`, `MISE_STATE_DIR`, `MISE_CACHE_DIR`, `MISE_CONFIG_DIR` and `MISE_GLOBAL_CONFIG_FILE`. For example, with every path replaced by a reviewed service-host location:

```json
{
  "runtime": {
    "toolchainEnv": {
      "PATH": "/opt/service/mise/shims:/opt/service/pi/bin:/usr/bin:/bin",
      "MISE_DATA_DIR": "/opt/service/mise/data",
      "MISE_STATE_DIR": "/opt/service/mise/state",
      "MISE_CACHE_DIR": "/opt/service/mise/cache",
      "MISE_CONFIG_DIR": "/opt/service/mise/config",
      "MISE_GLOBAL_CONFIG_FILE": "/opt/service/mise/config/config.toml"
    }
  }
}
```

Each value is an absolute POSIX path; `PATH` is colon-separated with no relative or empty entries. There is no shell, template or `~` expansion. Other names, including `HOME` and Pi or credential variables, are rejected. The map appears in effective configuration and `--print-boundary` output, so it must hold no credentials. A declared name can't also be a `runtime.credentialEnv` name.

Declared entries replace the same inherited variables in the model child's already-filtered environment; the pipeline-managed variables such as `HOME` still take precedence. Omitted entries keep their inherited values. One declaration therefore serves the `pi --version --offline` probe, the RPC Pi process and the session's ordinary tools and checks. The parent job and deterministic operations keep their own environment. The default `{}` changes nothing, for an inherited toolchain that is already HOME-independent.

mise reads its installs, state (including trust), cache and configuration from `$HOME` unless told otherwise, so its shims fail under the runtime HOME. To keep HOME-relative mise shims working, declare the operator-selected `PATH` and all five mise locations, using the operator's real directories rather than paths under the runtime HOME. A real node bin first on `PATH` is not enough when npm, mise or checks still need mise's state. Preparation runs no install, trust command or configuration discovery.

Runtime HOME and each session's private `PI_CODING_AGENT_DIR` stay isolated: no personal Pi settings, packages, auth.json or resources are imported, and credential filtering is unchanged. Preserving toolchain locations deliberately gives sessions read access to that operator-owned non-secret configuration; this remains configuration isolation, not a sandbox.

## Explicit provisioning: existing operator host or a new clean VM

The installer copies the example profile, **not** a live provider, credentials or discovery cache. Missing provisioning fails; it never borrows the operator's personal profile. Do not start a job to discover missing dependencies.

1. Operator authorization, the approved exact-source fast gate and independent read-only pre-Land Security come first, with the exact source, trusted-input, current-policy and pre-Land target binding required by the [install runbook](../../../docs/reference/operations.md#install-a-release). The full suite is not an install prerequisite. Install the reviewed pipeline from a clean checkout through that runbook, retaining dry-run review, backups, job and test-consumer drain, and separate managed-artifact/installed-CLI acceptance. Do not change or run global/personal Pi setup as a side effect of pipeline installation.
2. Explicitly provision the trusted native Pi **1.4.0** executable on the job service's trusted PATH (including its required local dependencies). If node or other tools come from HOME-relative shims, declare `runtime.toolchainEnv` as described above. Check `pi --version --offline`; it must print `1.4.0`. The bounded launch check runs this same executable/version command, with the model child's environment, before RPC. This is a trusted installation/version contract, not cryptographic authentication of an executable or every dependency.
3. Separately install/review **pi-cliproxyapi 0.4.3** and its dependencies in an operator-controlled location, for example `/opt/pipeline/providers/pi-cliproxyapi/`. Set `runtime.providerExtension` to the **absolute** installed `index.ts` path; its adjacent package.json must identify that exact package/version. It is explicitly loaded, not discovered from a personal package list. Do not copy extension code into generated agent directories.
4. Provision a dedicated model-child HOME. `runtime.home: null` means `$ISSUE_PIPELINE_ROOT/runtime/home`; an override must be an absolute path (or `~/…`) different from the job HOME. Create it with private ownership/permissions for the service. Do **not** repoint HOME for the job/ops process: their existing GitHub auth/config remains unchanged.
5. Under that HOME, explicitly provision `.pi/agent/pi-cliproxyapi/config.json` from the installed `runtime/pi-cliproxyapi-config.example.json`. Set the real nonsecret HTTP(S) proxy endpoint, enable `builtinProviders.openai` or `builtinProviders.anthropic` (or both) with a nonempty explicit model whitelist, leave `customProviders` empty and retain `$PIPELINE_MODEL_KEY` as an environment reference. The supported optional `apiOverride` is `openai-responses` or `openai-completions` for OpenAI and `anthropic-messages` for Anthropic (or null); refreshIntervalMinutes must be absent/0. Config fields are validated strictly; unsupported shapes refuse rather than invoking generic compatibility behavior. The endpoint host cannot be the selected provider's native host, `api.openai.com` or `api.anthropic.com`: native get_state has no registration-origin field, so a same-native endpoint cannot distinguish CLIProxy registration from native fallback and is deliberately unsupported. The pipeline rejects literal/command-resolved API keys, nonempty usageKey, URL credentials/query/fragment and contextWindow overrides (including custom provider models). Credentials must not be in tracked configs, prompts or logs. The three layers are intentionally different: `runtime.credentialEnv` contains plain **names** (`PIPELINE_MODEL_KEY`), the plugin config contains **`$PIPELINE_MODEL_KEY`**, and the environment contains the separately supplied opaque credential. CLIProxy 0.4.3 treats bare `PIPELINE_MODEL_KEY` as a literal and does **not** support `${PIPELINE_MODEL_KEY}` in its resolver. It resolves `$NAME` before passing the resulting value to native registration; Pi 1.4.0 then interprets commands/templates again. Consequently the pipeline rejects resolved credential values beginning `!` or containing `$`, rather than accidentally executing/interpolating them. Do not use a native auth.json env-name convention or a shell expansion in place of this plugin config syntax.
6. Provision `.pi/agent/pi-cliproxyapi/discovery-cache.json` **separately from reviewed actual catalogue data**. CLIProxy's format is `{ "savedAt": <number>, "discovery": { "source": "well-known" or "v1-models", "upstreamVersion": <string or null>, "builtinProviders": [...], "customPool": [...], "serverDiscoveryExcludes": [...], "upstreamTotal": <integer> } }`. Builtin entries have `name`, `api`, `models`; each model has `id`, `name`, `reasoning`, positive `contextWindow`/`maxTokens` and numeric input/output/cacheRead/cacheWrite costs. Custom entries also have `api`, `suggestedProvider`, `ownedBy`. The pipeline validates this shape before native startup and requires exactly one cached provider entry, named `openai` or `anthropic` like the selected model's provider, containing each selected model. Empty/inapplicable/ambiguous cache or disabled/unlisted/malformed provider registration refuses before even the native version probe; a cache-shaped object or generic ACK is insufficient. No automatic discovery or cache generation runs in a job. A stale but valid cache is not refreshed at launch; the operator owns its provenance/freshness, and native metadata must still match. Do not invent cache windows or copy the rest of a personal agent profile. Provider catalogue provisioning can require separate service access/authorization; it is not a model-generation trial or something this source task performs.
7. Set `runtime.credentialEnv` to the explicit **names** of service-provided model credential variables (default `["PIPELINE_MODEL_KEY"]`); all must be present/nonblank in the model child's already-filtered environment. The provider's `$NAME` must name one of them. Do not designate GitHub or access-token variables: they are removed before runtime preparation and must remain unavailable to model sessions. Pipeline-managed variables (`HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`) also cannot be credential names: the pipeline replaces them, so they cannot supply the separately provisioned opaque value. Undeclared `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` (Pi 1.4.0's native fallback-auth environment inputs) are explicitly removed from model children. It can remain only when deliberately named as the proxy credential and referenced by the provisioned profile; the distinct-endpoint/registration checks still apply. This list validates required names; it is **not** an allowlist/filter for every other inherited environment variable or an OS secrets boundary.
8. Explicitly set all three `models` and their matching `runtime.modelContextWindows` in the operator repo config, as `openai/<id>` or `anthropic/<id>`; the example uses OpenAI for each. Anthropic models are registered at the endpoint without its trailing `/v1`, as the Anthropic SDK expects. Set the legacy access network descriptions to the actual proxy/tool hosts if appropriate; they remain descriptive, not enforced. Provision any needed shell/git/npm configuration intentionally in the dedicated HOME. Personal `.gitconfig`, `.npmrc`, proxy settings and credential helpers are not implicit dependencies. Do not provision GitHub push credentials/helpers into model HOME; pushes still go through the scoped pipeline_commit path.
9. Record versions/paths, profile/cache provenance and effective configuration **without credential contents**. Preserve the root's config, generated settings directories/session JSONL and recovery artifacts for later review/rollback. Runtime HOME is operator-owned state; install does not create, overwrite, migrate or delete it.

This is reproducible **configuration isolation**, not filesystem, network, keyring or OS security sandboxing. Trusted extensions and model tools still execute with the service user's OS access. It does not solve the separately documented external GitHub authority races. Their documented limitations are unchanged.

## Delivery safety flow

The required safety flow is optional Gherkin → Implement's writing session → its fresh hardening session → Verify's exact-head configured checks, required CI and read-only review with its Security → an approval of that exact head, from Verify or a qualified person → Land's merge of the PR at that head and its close of the issue, in one result. A request for changes or a conflict goes to Fix, whose new head needs a new Verify. After Land, no fresh suite, Security model, repair writer or remerge may supply missing proof; missing or stale proof is a STOP. Land's read-only recovery reads the PR's merged state and the issue's state and never merges or closes twice. hippy/lawd are this operator's configured development/review identities, not reusable pipeline constants.

Docs are tracked Markdown in the repository's `docs/`, merged with code, not published separately. See the [runtime reference](../../../docs/reference/runtime.md) and [operations reference](../../../docs/reference/operations.md) for policy and installation.

A source-side effective-config read is distinct from either a job or `--print-boundary`. From the reviewed repo root, with an explicitly selected operator config path:

```bash
node --input-type=module - /absolute/operator/repo.json <<'JS'
import { loadConfig } from './apps/issue-host/src/config.ts';
import { policyOf, RUNTIME_SCHEMA } from '@ecosystem/task-runtime/job/runtime-policy';
const cfg = loadConfig(process.argv[2]);
const runtime = RUNTIME_SCHEMA.parse(cfg.runtime);
const policies = Object.fromEntries(Object.entries(cfg.models).map(([profile, model]) => [profile, policyOf(model, runtime)]));
console.log(JSON.stringify({ models: cfg.models, policies }, null, 2));
JS
```

This reads/parses local config and prints expectations/names/paths only. It does not read token files, contact GitHub/provider, load provider code, validate catalogue freshness, create a job, pin installed prompts or prove a native runtime has successfully launched. Check profile/cache existence/schema and package provenance separately during provisioning, without printing credentials. Actual runtime verification is still fail-closed on the first subsequently authorized session. Never substitute a fake generic get_state ACK for that evidence.

## Source/API evidence (pinned versions)

Paths below are relative to the corresponding installed package, read-only evidence rather than a reliance on a particular host's installation path:

- Pi `dist/main.js` (line numbers from the 1.2.0 review; 1.4.0 was rechecked by a get_state probe with the launch flags, which showed the same RPC precedence, cached proxy registration and enabled compaction): `resolveMode` (explicit RPC before print, lines 81–89), agentDir/bootstrap settings (468), project trust/runtime settings (595–600), CLI resource-loader flags. `dist/config.js` resolves `PI_CODING_AGENT_DIR`; `docs/settings.md` and `dist/core/settings-manager.js` describe native settings. `getCompactionTokenSetting`/`getCompactionSettings` (632–660) resolve exact model overrides ahead of ordinary settings, which is why merging an ambient profile is unsafe.
- Pi `dist/core/compaction/compaction.js`: `shouldCompact` (173–176), `findCutPoint`/projected retained boundary (334–349, 552–625); `dist/core/agent-session.js` `_checkCompaction`, `_runAutoCompaction` and appendCompaction/replaceMessages (2361–2627) implement native continuation rather than a pipeline restart. `dist/core/session-manager.js` and `docs/session-format.md` define append-only entries and context projection. The threshold is strict `>` and retention is approximate.
- Pi `dist/modes/rpc/rpc-mode.js` `get_state` (345–356) returns the actual native `model` object and enabled compaction, **not** reserve/retention settings. `docs/rpc.md` defines lifecycle/commands. `SettingsManager.applyOverrides()` exists in the SDK but is not exposed through ExtensionContext; no supported CLI/RPC token-settings setter justifies an extension-mutation shortcut. The existing CLI/RPC is retained instead of replacing it with an SDK runner.
- CLIProxy **0.4.3** `index.ts` `isHeadlessRun` (59–66) and initialization (224–308): `--print` selects cached registration, bypasses discovery/revalidation and background refresh; quota callbacks return without UI. `src/config.ts` CONFIG_DIR (49) hardcodes `homedir()/.pi/agent/pi-cliproxyapi`, so agentDir isolation alone is insufficient; `resolveConfigValue` (231 onward) resolves `$NAME`, not a bare name or `${NAME}`. Native `dist/core/resolve-config-value.js` (119–136, 192–217) treats bare names as literals and resolves `$NAME`/`${NAME}` templates or leading-`!` commands; the opaque credential is therefore checked before this second interpretation. `src/cache.ts` defines discovery-cache persistence; `src/apply.ts` (40–190) registers builtin models from Pi's catalogue/proxy metadata and applies configured overrides, which this profile forbids for windows. `src/compat.ts` defines endpoint/API normalization.

## Bounded offline evidence

Default tests `runtime-policy.test.mjs`, `runtime-startup.test.mjs`, `runtime-history.test.mjs`, `runtime-provider.test.mjs` and `runtime-toolchain.test.mjs` use private HOME/root, a default-deny fake executable and explicit profile/credential fixtures. They cover every stage/phase, hostile personal/project settings, changed native metadata, missing/invalid provisioning, version drift, window math/refusals, generated-settings/provider-profile mutation, preflight steering, preserved archived histories/new isolated policy directories, undeclared native OpenAI auth removal, empty/inapplicable cache/config, same-native-endpoint ambiguity and unchanged structured-output/compaction-event lifecycle/tool/credential ceilings. The toolchain fixture's node, npm and mise shims fail under any HOME but the operator's unless the declared mise locations are present; the probe and RPC child must select the same tools and versions as the same-cwd operator baseline. A fake is transport/policy evidence only.

Opt-in native proof, supplying a specifically reviewed local native package directory:

```bash
cd apps/issue-host
node test/job/runtime-native-proof.mjs /absolute/path/to/@earendil-works/pi-coding-agent /absolute/path/to/pi-cliproxyapi
```

It supplies a throw-on-generation fake provider, denies fetch/socket/TLS/subprocess operations in the child, sends **get_state only**, and proves native RPC wins over print with compaction enabled. A second guarded child reads the tracked example and imports the actual installed CLIProxy config-value resolver source (config.ts/log.ts copied byte-for-byte into private temp because Node cannot strip TypeScript under node_modules) plus Pi's native resolver, proving `$NAME` versus bare-name/literal semantics with an opaque fake credential only (no provider index or generation loaded). It also calls native SettingsManager/shouldCompact and SessionManager APIs: the strict threshold, project-setting exclusion and same-session summary/retained-context persistence hold while raw history remains on disk. The summary in this persistence test is synthetic; no real summary generation or live provider is claimed. CLIProxy's cache-only behavior is version-pinned source evidence, not a live-provider smoke test.
