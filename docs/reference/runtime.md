# Runtime

This page summarizes the model runtime every session uses: Pi's native sessions under settings the pipeline generates. The full contract and provisioning steps are in the pipeline's [runtime README](../../apps/issue-pipeline/runtime/README.md). The rule is [pipeline-owned-native-runtime](../decisions/operations.md#pipeline-owned-native-runtime).

## Supported runtime

Every session (Author, Developer, hardening, Sync resolver and Security) runs native **Pi 1.2.0** with the **pi-cliproxyapi 0.4.3** provider extension, over Pi's RPC mode. The only supported profile is OpenAI builtin registration through a distinct CLIProxy endpoint, not `api.openai.com`. Any other version, provider or profile refuses to start; there's no fallback.

- Each session gets a new private `PI_CODING_AGENT_DIR` holding only pipeline-generated settings. Personal settings, models, auth files, packages, extensions, skills, prompt templates and themes aren't copied. Project settings and resource discovery are off.
- Model children use a dedicated HOME: `runtime.home`, default `$ISSUE_PIPELINE_ROOT/runtime/home`. The job and its operations keep their own HOME.
- `runtime.toolchainEnv` declares the non-secret `PATH` and mise locations (`MISE_DATA_DIR`, `MISE_STATE_DIR`, `MISE_CACHE_DIR`, `MISE_CONFIG_DIR`, `MISE_GLOBAL_CONFIG_FILE`) that the version probe, Pi and session tools share, default `{}`. Values are absolute paths. Declare them when node or other tools come from HOME-relative mise shims, which otherwise fail under the dedicated HOME. The [runtime README](../../apps/issue-pipeline/runtime/README.md#declared-toolchain-isolated-model-configuration) gives an example.
- `runtime.credentialEnv` lists the names of model credential variables, default `["PIPELINE_MODEL_KEY"]`. Each must be set in the session's filtered environment. GitHub token variables can't be named.

This is configuration isolation, not a filesystem, network, keyring or OS sandbox.

## Context compaction

Pi's native automatic compaction targets 175,000 tokens and keeps about 30,000 tokens of recent history, in the same session. For a model with a 272,000-token window, the generated `reserveTokens` is 97,000.

`runtime.modelContextWindows` must declare each configured model's expected native window. A missing entry, or a window at or below 175,000, refuses before launch. The declaration is an expectation to check, not an override.

Compaction is context management, not a token or spending cap. There are no session budgets; see [telemetry](telemetry.md).

## Models

Set `models.author`, `models.implementor` and `models.reviewer` explicitly in the repository config, with matching `runtime.modelContextWindows`. Model strings pass unchanged to `--model`. The default and example model is `openai/gpt-6.1-sol`.

## Startup verification

Before the first prompt, the native `get_state` reply must match the configured provider, model, window and endpoint, with automatic compaction on. The generated settings and provider files are hashed again at that point. Any mismatch fails the launch without a prompt.

`job.json` records a `runtimePolicy` entry per launch with the verified numbers, versions and SHA-256 provenance of settings, provider profile and cache, never credential values.

## Recover from a runtime refusal

1. Read the refusal in `job.log`. It names the missing or mismatched item.
2. Fix provisioning: the Pi version on the service's `PATH`, `runtime.toolchainEnv`, `runtime.providerExtension`, the provider config and discovery cache under the model HOME, credential names or `modelContextWindows`. Follow the [runtime README](../../apps/issue-pipeline/runtime/README.md) provisioning steps.
3. Don't invent cache windows, copy a personal profile or remove a version check to get a launch through.
4. Restart the issue on its saved stage, branch and lane.
