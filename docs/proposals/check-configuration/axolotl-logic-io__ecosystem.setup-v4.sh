#!/usr/bin/env bash
# Locked public-npm provisioning only; no lifecycle scripts, models or ambient credentials.
set -euo pipefail
mode=${1-setup-v4}
[[ $# -le 1 && "$mode" == setup-v4 ]] || { printf '%s\n' 'expected setup-v4 only' >&2; exit 2; }
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
sandbox=$(mktemp -d /tmp/ecosystem-setup-v4.XXXXXXXX)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox"/{home,root,tmp,bin,mise-data,mise-cache,mise-state,mise-config}
for cli in gh pi curl wget; do
  printf '#!/bin/sh\necho "live %s is forbidden in pipeline tests" >&2\nexit 97\n' "$cli" > "$sandbox/bin/$cli"
  chmod 700 "$sandbox/bin/$cli"
done
npm_cli="$node_bin/../lib/node_modules/npm/bin/npm-cli.js"
[[ -f "$npm_cli" ]]
[[ $(env -i PATH="$node_bin:/usr/bin:/bin" "$node_bin/node" "$npm_cli" --version) == 11.19.0 ]]
mkdir -p "$sandbox/npm-cache"
: > "$sandbox/npm-user-config"
: > "$sandbox/npm-global-config"
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
 MISE_TRUSTED_CONFIG_PATHS="$checkout/mise.toml:$checkout/apps/issue-pipeline/mise.toml" NPM_CONFIG_OFFLINE=false \
 NPM_CONFIG_USERCONFIG="$sandbox/npm-user-config" \
 NPM_CONFIG_GLOBALCONFIG="$sandbox/npm-global-config" NPM_CONFIG_CACHE="$sandbox/npm-cache" \
 NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ NPM_CONFIG_STRICT_SSL=true \
 NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false \
 NPM_CONFIG_UPDATE_NOTIFIER=false \
 /bin/bash -euo pipefail -c '
  mise=$1
  node=$2
  npm_cli=$3
  checkout=$4
  # Preflight has established both exact regular tracked reviewed configurations.
  # Trust records live only in the owned isolated mise state, not operator HOME.
  "$mise" trust --quiet "$checkout/mise.toml" </dev/null
  "$mise" trust --quiet "$checkout/apps/issue-pipeline/mise.toml" </dev/null
  "$node" "$npm_cli" ci --ignore-scripts --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ --strict-ssl --fetch-retries=0
' ecosystem-setup-v4 "$mise" "$node_bin/node" "$npm_cli" "$checkout" </dev/null
