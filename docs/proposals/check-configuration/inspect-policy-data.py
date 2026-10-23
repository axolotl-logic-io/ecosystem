"""Data-only evidence construction. Does not import or execute the proposed preflight or source."""
import ast
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

D = Path('/Users/axolotl-logic/workspace/agent-handoffs/project-buddy/20261019-launch-ready/dispatch-20261022-four-lane-drain')
O = D / 'approved-eco-policy-v4'
R = D / 'ecosystem-throughput/source'
REV164 = 'a8bf64fd858fb2294588c3d4f674f31a6f1849fd'
REV178 = '57656391c85ebb2b918096bc398717e7a00ad626'

def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-replace-objects', '-C', str(R), *args])

def sha(data):
    return hashlib.sha256(data).hexdigest()

def blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

# Independently reconstruct the combined F1/F2/F3 packet from actual 178 blobs.
patch = D / 'approved-eco178-install-policy/patches/57656391-to-result.patch'
assert sha(patch.read_bytes()) == '54d47d906a5efb533a111150ee7aaf496ced526c3f89f6b3241e15c5f757a624'
lines = patch.read_bytes().splitlines(keepends=True)
results = {}
i = 0
hunks = 0
while i < len(lines):
    if not lines[i].startswith(b'diff --git '):
        i += 1
        continue
    path = lines[i].decode().rstrip().split(' b/', 1)[1]
    original = git('show', REV178 + ':' + path).splitlines(keepends=True)
    out = []
    cursor = 0
    i += 1
    while i < len(lines) and not lines[i].startswith(b'diff --git '):
        if not lines[i].startswith(b'@@ '):
            i += 1
            continue
        match = re.match(rb'@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', lines[i])
        assert match
        start = int(match[1]) - 1
        oldcount = int(match[2] or b'1')
        newcount = int(match[4] or b'1')
        assert start >= cursor
        out += original[cursor:start]
        cursor = start
        oldseen = newseen = 0
        i += 1
        while i < len(lines) and lines[i][:1] in {b' ', b'+', b'-'}:
            mark, content = lines[i][:1], lines[i][1:]
            if mark != b'+':
                assert original[cursor] == content
                cursor += 1
                oldseen += 1
            if mark != b'-':
                out.append(content)
                newseen += 1
            i += 1
        assert (oldseen, newseen) == (oldcount, newcount)
        hunks += 1
    out += original[cursor:]
    data = b''.join(out)
    assert data == (D / 'approved-eco178-install-policy/snapshots/result' / path).read_bytes()
    results[path] = data
assert len(results) == 6 and hunks == 14

profilefile = O / 'ecosystem.policy-v4.execution-inputs.json'
profile = json.loads(profilefile.read_bytes())
preflight = (O / 'ecosystem.policy-v4.preflight.py').read_text()
ast.parse(preflight)  # Parse syntax only, never run it.
assert sha(profilefile.read_bytes()) in preflight
vectors = {}
observations = []
for variant in profile['variants']:
    rev = variant['referenceCommit']
    objects = {}
    tree = {}
    for entry in git('ls-tree', '-rz', rev).split(b'\0'):
        if entry:
            meta, path = entry.split(b'\t', 1)
            mode, kind, objectid = meta.decode().split()
            tree[path.decode()] = (mode, objectid)
    for entry in variant['inputs']:
        p = entry['path']
        data = results[p] if rev == REV178 and p in results else git('show', rev + ':' + p)
        assert entry['mode'] == tree[p][0] == '100644'
        assert (entry['sha256'], entry['gitBlob'], entry['bytes']) == (sha(data), blob(data), len(data))
        objects[p] = data
    # Independent name inventory for the proposed discovery scope.
    def config_name(name):
        low = name.lower()
        return ('mise' in low or low.startswith('tsconfig') and low.endswith('.json')
                or low in {'biome.json', 'biome.jsonc', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.gitignore', '.tool-versions', '.node-version', '.nvmrc'})
    discovered = set()
    for p in tree:
        parts = Path(p).parts
        if (len(parts) == 1 or len(parts) == 2 and parts[0] == 'apps' or p.startswith('apps/issue-pipeline/')) and config_name(parts[-1]):
            discovered.add(p)
    assert discovered == set(profile['discoveryInputs']) - {'apps/workflow-dash/package.json'}
    assert {p for p in tree if re.fullmatch(r'apps/[^/]+/package.json', p)} == set(profile['workspaceManifests'])
    lock = json.loads(objects['package-lock.json'])
    remote = []
    links = {}
    for p, entry in lock['packages'].items():
        if not p.startswith('node_modules/'):
            continue
        if entry.get('link'):
            links[p] = entry['resolved']
        else:
            u = urlsplit(entry['resolved'])
            assert u.scheme == 'https' and u.netloc == 'registry.npmjs.org' and not u.query and not u.fragment
            assert u.path.endswith('.tgz')
            assert entry['integrity'].startswith('sha512-')
            assert len(base64.b64decode(entry['integrity'][7:], validate=True)) == 64
            remote.append({'package': p, 'url': entry['resolved'], 'integrity': entry['integrity']})
    assert links == profile['workspaceLinks']
    vectors[variant['id']] = objects
    observations.append({'variant': variant['id'], 'referenceCommit': rev, 'matchedInputs': len(objects), 'trackedDiscoveryPaths': sorted(discovered), 'publicNpmTarballs': len(remote), 'workspaceLinks': links})
    if rev == REV164:
        (O / 'reviewed-public-npm-lock-inventory.json').write_text(json.dumps(remote, indent=2) + '\n')
assert [p for p in vectors['eco164-existing-cleanup-v4'] if vectors['eco164-existing-cleanup-v4'][p] != vectors['eco178-f1-f2-f3-v4'][p]] == ['apps/issue-pipeline/mise.toml', 'apps/issue-pipeline/test/check-task.test.mjs']
assert sha(results['apps/issue-pipeline/runtime/README.md']) == 'b8c7d1de6eccdcb3a051997b1d4cad90f1a49ce2438ef66343e4d00e72997776'
assert not any('/runtime/README.md' in e['path'] for v in profile['variants'] for e in v['inputs'])

# Old v3 reasoned mismatch, not an invocation of its preflight.
v3 = json.loads((D / 'approved-eco-policy-v3/ecosystem.fast-v3.execution-inputs.json').read_bytes())
v3runtime = next(e for e in v3['inputs'] if e['path'] == 'apps/issue-pipeline/runtime/README.md')
assert v3runtime['sha256'] == '8eb37ca347a44c530eb92b9013c2168c6188d7c6ef167aa5f603e8796bbbb30e'
assert v3runtime['sha256'] != sha(results['apps/issue-pipeline/runtime/README.md'])
v3app = next(e for e in v3['inputs'] if e['path'] == 'apps/issue-pipeline/mise.toml')
assert v3app['sha256'] != sha(vectors['eco164-existing-cleanup-v4'][v3app['path']])

shells = ['axolotl-logic-io__ecosystem.fast-v4.test.sh', 'axolotl-logic-io__ecosystem.setup-v4.sh']
prehash = sha((O / 'ecosystem.policy-v4.preflight.py').read_bytes())
for name in shells:
    text = (O / name).read_text()
    assert prehash in text and 'python3 -I -S -' in text
    bootstrap = text.split("<<'PREFLIGHT'\n", 1)[1].split('\nPREFLIGHT', 1)[0]
    ast.parse(bootstrap)
    assert text.index('expected ') < text.index('PATH=') < text.index('variant=$(')
    assert 'MISE_YES' not in text
    assert 'MISE_TRUSTED_CONFIG_PATHS="$checkout/mise.toml:$checkout/apps/issue-pipeline/mise.toml"' in text
    assert text.rstrip().endswith('</dev/null')
text = (O / shells[0]).read_text()
assert text.count('"$node" --test --test-concurrency=2 --test-timeout=180000 test/build.test.mjs test/check-task.test.mjs') == 1
assert text.count('"$node" --test --test-concurrency=2 --test-timeout=180000 "test/**/*.test.mjs"') == 1
syntax = text.split('for file in ', 1)[1].split('; do', 1)[0].replace('\\\n', '').split()
assert len(syntax) == 10
assert text.index('test/build.test.mjs test/check-task.test.mjs') < text.index('case "$mode" in', text.index('cd apps/issue-pipeline'))
assert 'NPM_CONFIG_OFFLINE=true' in text
setup = (O / shells[1]).read_text()
assert setup.index('variant=$(') < setup.index('"$mise" trust') < setup.index('"$node" "$npm_cli" ci')
assert '--ignore-scripts --no-audit --no-fund' in setup and '--fetch-retries=0' in setup
assert 'NPM_CONFIG_OFFLINE=false' in setup and 'MISE_OFFLINE=1 MISE_AUTO_INSTALL=0' in setup

output = {'kind': 'Static immutable-byte compatibility; no preflight/wrapper/source execution', 'combined178Packet': {'sha256': sha(patch.read_bytes()), 'paths': len(results), 'hunks': hunks}, 'variants': observations, 'variantDifferences': ['apps/issue-pipeline/mise.toml', 'apps/issue-pipeline/test/check-task.test.mjs'], 'v3Mismatch': {'runtimeReadmePinned': v3runtime['sha256'], 'F3runtimeReadme': sha(results['apps/issue-pipeline/runtime/README.md']), 'app178Pinned': v3app['sha256'], 'app164Actual': sha(vectors['eco164-existing-cleanup-v4'][v3app['path']])}, 'syntaxInputs': syntax, 'pythonSyntaxOnly': 'ast.parse shared preflight and both bootstraps; not executed', 'shellSyntax': 'recorded separately after final-byte freeze'}
(O / 'static-compatibility-evidence.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))
