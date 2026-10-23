#!/usr/bin/env bash
# Pipeline-only gate: pinned provisioned tools, no operator HOME/config or live CLI.
set -euo pipefail
# A versioned command argument makes this operator policy change visible to
# the installed policy digest. This file is a proposal, not installed policy.
mode=${1-fast-v4}
[[ $# -le 1 ]] || { printf '%s\n' 'expected one policy mode' >&2; exit 2; }
case "$mode" in
  fast-v4|full-v4) ;;
  *) printf '%s\n' 'expected fast-v4 or full-v4' >&2; exit 2 ;;
esac
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
checkout=$(pwd -P)
# Shared reviewed bytes run before any trust, provisioning or task effect.
policy_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
variant=$(env -i PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
 GIT_ALLOW_PROTOCOL=file GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 \
 /usr/bin/python3 -I -S - "$checkout" "$policy_dir" <<'PREFLIGHT'
import hashlib
from pathlib import Path
import stat
import sys
root, directory = sys.argv[1:]
file = Path(directory) / "ecosystem.policy-v4.preflight.py"
if not stat.S_ISREG(file.lstat().st_mode) or file.resolve() != file:
    raise SystemExit("v4 shared preflight must be regular and nonsymlink")
raw = file.read_bytes()
if hashlib.sha256(raw).hexdigest() != "18235e0c11bced29071a40260b04270f4d38ebd327e75198fe6870acc3ae8b45":
    raise SystemExit("v4 shared preflight digest mismatch")
sys.argv = [str(file), root, str(Path(directory) / "ecosystem.policy-v4.execution-inputs.json")]
exec(compile(raw, str(file), "exec"), {"__name__": "__main__"})
PREFLIGHT
)
printf 'v4 execution-policy compatibility: %s; NOT source/input/policy/target authority\n' "$variant"
# Require provisioned versions; no ambient shim, tool download or fallback.
node_bin=/Users/axolotl-logic/.local/share/mise/installs/node/24.21.0/bin
mise=/Users/axolotl-logic/.local/bin/mise
[[ -x "$node_bin/node" && -x "$node_bin/npm" && -x "$mise" ]]
[[ $(env -i PATH="$node_bin:/usr/bin:/bin" "$node_bin/node" --version) == v24.21.0 ]]
[[ $(env -i "$mise" --version) == '2026.9.4 macos-arm64 (2026-09-09)' ]]
# Keep Unix socket paths short and normalized (ambient macOS TMPDIR ends in /).
sandbox=$(mktemp -d /tmp/ecosystem-gate.XXXXXXXX)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox"/{home,root,tmp,bin,mise-data,mise-cache,mise-state,mise-config}
for cli in gh pi curl wget; do
  printf '#!/bin/sh\necho "live %s is forbidden in pipeline tests" >&2\nexit 97\n' "$cli" > "$sandbox/bin/$cli"
  chmod 700 "$sandbox/bin/$cli"
done
env -i HOME="$sandbox/home" ISSUE_PIPELINE_ROOT="$sandbox/root" \
 PATH="$sandbox/bin:$node_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
 TMPDIR="$sandbox/tmp" LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ALLOW_PROTOCOL=file \
 MISE_DATA_DIR="$sandbox/mise-data" MISE_CACHE_DIR="$sandbox/mise-cache" \
 MISE_STATE_DIR="$sandbox/mise-state" MISE_CONFIG_DIR="$sandbox/mise-config" \
 MISE_GLOBAL_CONFIG_FILE="$sandbox/mise-config/config.toml" \
 MISE_SYSTEM_CONFIG_DIR="$sandbox/mise-config" \
 MISE_CEILING_PATHS="$(dirname "$checkout")" \
 XDG_CONFIG_HOME="$sandbox/mise-config" XDG_DATA_HOME="$sandbox/mise-data" \
 XDG_CACHE_HOME="$sandbox/mise-cache" XDG_STATE_HOME="$sandbox/mise-state" \
 MISE_OFFLINE=1 MISE_AUTO_INSTALL=0 \
 MISE_TRUSTED_CONFIG_PATHS="$checkout/mise.toml:$checkout/apps/issue-pipeline/mise.toml" NPM_CONFIG_OFFLINE=true \
 /bin/bash -euo pipefail -c '
  mise=$1
  node=$2
  mode=$3
  cd apps/issue-pipeline
  printf "ecosystem verification policy: %s\n" "$mode"
  "$mise" //apps/issue-pipeline:typecheck
  "$mise" //apps/issue-pipeline:lint
  "$mise" //apps/issue-pipeline:build
  for file in install.mjs dist/ops.mjs dist/shell-supervisor.mjs \
    dist/job.mjs dist/orchestrate.mjs dist/report.mjs \
    dist/pipeline-commit.mjs dist/structured-output.mjs dist/git-review.mjs dist/caller-jobs.mjs; do
    "$node" --check "$file"
  done
  "$node" --test --test-concurrency=2 --test-timeout=180000 test/build.test.mjs test/check-task.test.mjs
  case "$mode" in
    fast-v4)
      printf "%s\n" "Fast default: build and check-task guards; full integration/flow suite not run."
      ;;
    full-v4)
      printf "%s\n" "Opt-in: fast prerequisite already ran; unchanged full selection repeats both guard files."
      "$node" --test --test-concurrency=2 --test-timeout=180000 "test/**/*.test.mjs"
      ;;
  esac
' ecosystem-policy "$mise" "$node_bin/node" "$mode" </dev/null
