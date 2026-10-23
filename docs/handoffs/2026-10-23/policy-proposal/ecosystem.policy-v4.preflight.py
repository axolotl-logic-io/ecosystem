"""Execution-policy compatibility only; canonical source/input/policy/target authority is separate."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit

PROFILE_SHA256 = "e1ba88f79adc291aaebec7d6a1e5d35c687fc53a9afc1a3eecc56b10b1290a14"

def require(ok, message):
    if not ok:
        raise SystemExit("v4 preflight refused: " + message)

def regular(path):
    require(stat.S_ISREG(path.lstat().st_mode), "expected regular file: " + str(path))
    require(path.resolve() == path, "symlink path component: " + str(path))

root = Path(sys.argv[1])
profile_path = Path(sys.argv[2])
require(root.is_absolute() and root.resolve() == root, "noncanonical checkout")
require(not any(c in str(root) for c in ":\n\r"), "checkout encodes trust-path list")
regular(profile_path)
raw = profile_path.read_bytes()
require(hashlib.sha256(raw).hexdigest() == PROFILE_SHA256, "companion digest")
profile = json.loads(raw)

def git(*args):
    return subprocess.check_output(
        ["/usr/bin/git", "--no-replace-objects", "-c", "core.fsmonitor=false", "-C", str(root), *args],
        stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=30,
    )

require(git("rev-parse", "--show-toplevel").decode().rstrip("\n") == str(root), "run from checkout root")
indexed = {}
for item in git("ls-files", "--stage", "-z").split(b"\0"):
    if item:
        meta, name = item.split(b"\t", 1)
        mode, blob, stage = meta.decode().split()
        require(stage == "0", "unmerged index")
        indexed[name.decode()] = (mode, blob)
committed = {}
for item in git("ls-tree", "-rz", "HEAD").split(b"\0"):
    if item:
        meta, name = item.split(b"\t", 1)
        mode, kind, blob = meta.decode().split()
        committed[name.decode()] = (mode, blob)

# All selected bytes must match ONE reviewed recipe, never a Cartesian mixture.
matching = []
for variant in profile["variants"]:
    if all(indexed.get(e["path"]) == (e["mode"], e["gitBlob"])
           and committed.get(e["path"]) == (e["mode"], e["gitBlob"])
           for e in variant["inputs"]):
        matching.append(variant)
require(len(matching) == 1, "no unique reviewed harness variant")
variant = matching[0]
expected = {e["path"]: e for e in variant["inputs"]}
for p, e in expected.items():
    file = root / p
    regular(file)
    require(bool(file.stat().st_mode & stat.S_IXUSR) == (e["mode"] == "100755"), "executable mode: " + p)
    require(hashlib.sha256(file.read_bytes()).hexdigest() == e["sha256"], "working policy input: " + p)

# Discover policy/config names, NOT ordinary source or test hashes. Reject new
# config even if ignored, before delegated discovery can load it. Read no env file.
def policy_name(name):
    lower = name.lower()
    return ("mise" in lower or lower.startswith("tsconfig") and lower.endswith(".json")
            or lower in {"biome.json", "biome.jsonc", "package.json", "package-lock.json",
                         "npm-shrinkwrap.json", ".npmrc", ".gitignore", ".tool-versions",
                         ".node-version", ".nvmrc"})

allowed = set(profile["discoveryInputs"])
for directory in [root, root / "apps"]:
    require(directory.is_dir() and directory.resolve() == directory, "nonplain config ancestry")
    for item in directory.iterdir():
        if policy_name(item.name):
            require(str(item.relative_to(root)) in allowed, "unexpected ancestry config: " + str(item))
    require(not os.path.lexists(directory / ".config/mise"), "unexpected .config/mise")
app = root / "apps/issue-pipeline"
for directory, dirs, files in os.walk(app, followlinks=False):
    directory = Path(directory)
    require(directory.resolve() == directory, "symlink config ancestry")
    require(not os.path.lexists(directory / ".config/mise"), "unexpected .config/mise")
    for name in dirs + files:
        if policy_name(name):
            require(str((directory / name).relative_to(root)) in allowed, "unexpected pipeline config: " + str(directory / name))
    dirs[:] = [d for d in dirs if d not in {"node_modules", "dist", ".git", "coverage"}]

# npm ci uses the root workspace definition. New workspace manifests need review.
workspaces = set()
for directory in (root / "apps").iterdir():
    if os.path.lexists(directory / "package.json"):
        require(directory.is_dir() and directory.resolve() == directory, "nonplain workspace")
        workspaces.add(str((directory / "package.json").relative_to(root)))
require(workspaces == set(profile["workspaceManifests"]), "workspace package set changed")
for p in set(indexed) | set(committed):
    parts = Path(p).parts
    in_ancestry = len(parts) == 1 or len(parts) == 2 and parts[0] == "apps"
    in_pipeline = p.startswith("apps/issue-pipeline/")
    if (in_ancestry or in_pipeline) and policy_name(parts[-1]):
        require(p in allowed, "unreviewed tracked discovery input: " + p)
# Ordinary untracked source/test inputs remain refused, without freezing tracked
# production or nonselected tests. Ignored dependencies/build output are separate.
for item in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
    if item:
        p = item.decode()
        require(not p.startswith("apps/issue-pipeline/"), "untracked pipeline input: " + p)

# The locked setup may retrieve only public HTTPS npm tarballs. Local links are
# precisely the two pinned workspaces, never file/Git/source download specs.
lock = json.loads((root / "package-lock.json").read_bytes())
require(lock["lockfileVersion"] == 3, "lock format")
packages = lock["packages"]
require({p for p in packages if not p.startswith("node_modules/")} == {"", *profile["workspaceDirectories"]}, "lock workspace set")
for p, entry in packages.items():
    if not p.startswith("node_modules/"):
        continue
    if entry.get("link"):
        require(profile["workspaceLinks"].get(p) == entry["resolved"], "unreviewed local link")
    else:
        url = urlsplit(entry.get("resolved", ""))
        require(url.scheme == "https" and url.netloc == "registry.npmjs.org"
                and not url.query and not url.fragment and url.path.endswith(".tgz")
                and "/../" not in url.path, "nonpublic npm tarball: " + p)
        integrity = entry.get("integrity", "")
        require(re.fullmatch(r"sha512-[A-Za-z0-9+/]+={0,2}", integrity) is not None, "missing sha512: " + p)
        require(len(base64.b64decode(integrity[7:], validate=True)) == 64, "invalid sha512: " + p)
print(variant["id"])
