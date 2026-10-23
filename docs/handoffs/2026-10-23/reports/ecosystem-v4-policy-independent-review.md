# Ecosystem v4 policy independent review

## Scoped verdict

**PASS for the frozen setup/test/preflight/profile proposal's byte derivation, bounded recipe and stated compatibility boundary. HOLD for actual adoption, phase execution and installation until the parent resolves the specific prerequisites below.** No introduced P1 bypass or P1 correctness defect was established by this read-only review. This is not a runtime pass, canonical Review, Hardening, Security clearance, policy application or permission to start a phase.

V4 addresses all three concrete v3 profile limitations: actual #164 has its own intact task/guard vector; F3's runtime documentation no longer conflicts with compatibility; ordinary changing production source and nonselected tests are not frozen as execution policy. The setup proposal also checks reviewed bytes before its own trust/provisioning effects, which a test-only preflight could not protect.

**The raw #178 mismatch is not, by itself, a proven dead end.** Independent tracing of installed `684473c` establishes a conditional normal route: a precreated stage checkout with **no laneSlots** avoids claim-time configured setup for Review as well as Implementation; Review can return changed requirements before hardening/verification; Developer can then commit the real correction before configured verification requires it. This conclusion comes from Review's actual call order, not an assumption based on historical Implementation startup. A lane-slot claim instead runs setup before the role guard and would refuse raw #178. The active setting and retained readiness/state were not freshly inspected here. Do not spend Review1 to discover which path applies.

Parent retains publication, phase routing, actual policy authority, exact current-target decisions, Security, Land, installation, acceptance and hold-release authority. Keep #164's truthful policy-only final Review path separate from eventual #178 adoption.

## Subjects and provenance

All paths below expand from these absolute locations:

- **H:** `/Users/axolotl-logic/workspace/agent-handoffs/project-buddy/20261019-launch-ready`.
- **D:** `H/dispatch-20261022-four-lane-drain`.
- **O:** `D/approved-eco-policy-v4`, immutable review packet.
- **R:** `D/ecosystem-throughput/source`, closed read-only object observer.
- **F:** `D/approved-eco178-install-policy`, immutable correction packet.
- **S:** `H/dispatch-20261022-pb-508-514/eco185-hotfix`, installed-commit supporting source observer.
- **P:** `S/apps/issue-pipeline`. Installed-source citations refer to commit `684473c2fc14f0510ffc0a6749570f2e0f49733a`, not the current #178 candidate.
- **I:** `/Users/axolotl-logic/.pi/agent/issue-pipeline`.

I read the absolute Auto grant first, then POLICY. I read the complete v4 author report and v3 independent review; bounded rereads covered both reports without relying on truncated combined output. I read actual candidate AGENTS, complete coding/project/docs practices, docs index and Decisions, the #164 removal ledger and pipeline README, and differing #178 guidance and pipeline README. Actual Git-tree inventories contain only root AGENTS and no CONTRIBUTING file. The #164 and #178 inspection copies independently match all 31 and 26 corresponding immutable object files. Installed supporting AGENTS/style agree with the already-read #164 copies; installed coding/project practices and docs index were also inspected as actual object data. Repository commands in guidance were not execution grants.

| Frozen artifact under O | Bytes | Independently computed SHA-256 |
| --- | ---: | --- |
| `axolotl-logic-io__ecosystem.fast-v4.test.sh` | 4445 | `295311a8ee075b95cbe6faab0829a150d3179acd4432df0dd0390fabe1d23a15` |
| `axolotl-logic-io__ecosystem.setup-v4.sh` | 4366 | `b352942e66cd3021c153a9667ad5e34266cf4aa559fd344a50b1725007ee9196` |
| `ecosystem.policy-v4.preflight.py` | 6548 | `18235e0c11bced29071a40260b04270f4d38ebd327e75198fe6870acc3ae8b45` |
| `ecosystem.policy-v4.execution-inputs.json` | 14533 | `e1ba88f79adc291aaebec7d6a1e5d35c687fc53a9afc1a3eecc56b10b1290a14` |

Both bootstraps embed the exact preflight digest; the preflight embeds the exact profile digest. These four artifacts must remain one reviewed versioned proposal, not separately replaceable defaults.

Other independently checked identities:

| Subject | Identity |
| --- | --- |
| Actual #164 | `a8bf64fd858fb2294588c3d4f674f31a6f1849fd`; tree `a08c487f722bd308c57902f11b54bef2cc068dbc` |
| Actual #178 reference | `57656391c85ebb2b918096bc398717e7a00ad626`; tree `04c59534ac69893895100c3aa6de7b8a14674616` |
| Combined #178 correction | `F/patches/57656391-to-result.patch`; SHA-256 `54d47d906a5efb533a111150ee7aaf496ced526c3f89f6b3241e15c5f757a624` |
| Inventory | `O/artifact-inventory.json`; SHA-256 `51900592b69f6d260e2f1971e7942155544be8d5176eeb4ed2a4965432e07c24` |
| Provenance | `O/proposal-provenance.json`; SHA-256 `35e44d038f71d3dcae29d5d4b6a55dc0319c93b818ddd363024c838addda8c43` |
| Final shell syntax evidence | `O/final-shell-syntax-evidence.json`; SHA-256 `7201587fcb9ada8ee08cac18c7005ca3b003d4bc8bd763040b79fb2ace588062` |

All 74 inventory entries match their actual file lengths and SHA-256; the on-disk file set is exactly those entries plus the inventory itself. I read the author inspection program as text, but did not execute it. My own inline Python regenerated both saved shell deltas with `difflib` and matched their complete bytes: `v3-to-v4-test.patch` SHA-256 `240b708f0100140219a608c8cdf989fb70f40a7bf7658bdf0bc607390c20892a`, and `old-setup-to-v4.patch` SHA-256 `7c1b33c30318ca79ea9bbb2d4e9b141057579bdd2ab70969da4bac449f64d8fd`. The old setup bytes independently hash to `6a4a17dd9a076b8669117804f78d08e402f1b65fb44841678ff0da059c1da843`.

## Independent recipe reconstruction

I reconstructed the combined correction in memory from actual `57656391` objects using my own patch reader. For each hunk it checked old and new line counts, old context/removals and new output positions. It checked old/new Git blob identities from each patch header, compared every reconstructed result with the saved result snapshot, and compared the final hashes/blob IDs with all 12 final records in `F/evidence/source-packet-manifest.json`. No patch was applied to disk and no tree/blob/commit was written.

The exact patch has six changed paths and fourteen hunks:

| Reconstructed path | Final SHA-256 |
| --- | --- |
| `README.md` | `fcfdeaeaf015d71971299e51745aee6843619bf989f00e6352cef2f59aa880b2` |
| `apps/issue-pipeline/README.md` | `0464cf178622fdea9236ec5b2a480ece125fff2d88ba9663a8e6dbb24280485c` |
| `apps/issue-pipeline/mise.toml` | `463b5789beb1af034b511397bf9a60427ab9258a41ef5ac1cc2184e1e64988b8` |
| `apps/issue-pipeline/runtime/README.md` | `b8c7d1de6eccdcb3a051997b1d4cad90f1a49ce2438ef66343e4d00e72997776` |
| `docs/reference/check-gates.md` | `605c7749162c5a6355422ec8e7a5addf69c12d3de9e2042146559f08120a18d5` |
| `docs/reference/operations.md` | `78b36bf21c4fa36bb0f69954256bdbad2c7c596d027c1a9e6d6e9f78c9a03381` |

The task guard is already present in the actual #178 object; the patch need not change it again. The unchanged final manifest records were compared to actual candidate objects, not assumed from the patch's changed-path list. This proves the uncommitted recipe's derivation. It supplies no future canonical commit, applied correction, check result or installation authority.

### Two indivisible vectors

For each profile record I independently checked regular Git mode, byte length, SHA-256, Git blob identity and stated provenance against actual #164 objects or actual #178 objects with only the reconstructed patch overlay. All **34 records** match. Both reference trees contain regular `100644` entries for these paths. The profile's absolute provenance snapshots also match the corresponding bytes.

| Variant | App TOML SHA-256 | Check-task guard SHA-256 |
| --- | --- | --- |
| `eco164-existing-cleanup-v4` | `09311fc18b9455ed971f6c3ae7da7c9f6c4c39132418a6d458de3bbd7c025ccc` | `fd87d06e094c962c0d69c509d5354141bfded211b9b6efc2cf38ebf3780e147d` |
| `eco178-f1-f2-f3-v4` | `463b5789beb1af034b511397bf9a60427ab9258a41ef5ac1cc2184e1e64988b8` | `45a499522fced0c7adc642e1a4d9f94b87f2a1243eb2f34095abf813619168c7` |

These are the only two differences. The other fifteen files are byte-identical across the two reviewed subjects. The shared root TOML hashes to `00d3061399caa0f3f74595a129c54d1573327bec6237ac5d86089f3e8d37e0ce`; the shared build guard hashes to `bfc2481f617e6ed55593ecfe1f0fd517f1eddaac0e36ed4fb607d85f0c7beefa`.

The seventeen paths have a coherent execution-policy purpose:

- Root `mise.toml` and app `mise.toml`: exact prospective trust and delegated task definitions.
- Root `package.json`, `package-lock.json`, app `package.json`, sibling `apps/workflow-dash/package.json`: npm workspace/dependency provisioning and actual npm command bodies, including the otherwise nonselected workspace installed by root `ci`.
- App `tsconfig.json` and `tsconfig.test.json`: source/test checked-JavaScript policy and fixture inheritance.
- Root/app `biome.jsonc` and root `.gitignore`: effective lint settings, selection and ignore behavior.
- App `build.ts`: build recipe, entrypoint set and target.
- App `test/build.test.mjs` and `test/check-task.test.mjs`: actual selected assertions, not merely filenames.
- App `test/credentials-test-kit.mjs`, `test/fake-gh.mjs`, `test/fake-execution-transport.mjs`: complete local helper closure of the selected build smoke. Their fake credential strings are test fixtures, not operator credentials.

Ordinary docs, production source, `install.mjs`, nonselected test bodies and generated/provisioned outputs are not this compatibility definition. They remain actual candidate inputs and must receive complete canonical source review and exact-source checking. Excluding them does not approve arbitrary future edits or weaken protected tests. The new profile does not revive v3's 621-file freeze or hash F3's ordinary runtime README.

## Control and boundary review

### Preflight before effects

Setup lines 4–5 and test lines 6–11 validate argument count and literal versioned mode before PATH assignment, `pwd`, companion work or tools. Omission defaults; explicit empty does not. Unknown/empty/extra arguments refuse. No mode is evaluated as shell code. These are semantic findings, not executed argument probes.

Both wrappers invoke `/usr/bin/python3 -I -S` under `env -i` (`setup:11–28`, `test:17–34`). The bootstrap checks the preflight's regular nonsymlink identity and digest before compiling its bytes. The shared preflight checks the profile's regular nonsymlink identity/digest before reading candidate policy inputs (`preflight:19–30`). Isolated Python excludes candidate/user-site/site imports. I used `ast.parse` on those three Python texts only; I did not run any bootstrap or preflight.

`preflight:32–68` uses absolute Git with replacements and fsmonitor disabled, NUL-delimited stage/tree parsing, an unmerged-index refusal, exact HEAD/index mode/blob comparisons, one unique whole-vector match, and regular working paths plus owner-executable-bit/hash checks. Root canonicality and colon/newline refusal prevent list injection. Whole-vector selection rejects crossed old/new task/guard pairs. A corrected but uncommitted task file still fails: HEAD, index and working bytes must all match the selected vector.

Git inherits only the bootstrap's restricted environment: global/system config disabled, lazy fetch and optional locks disabled, file-only transport. These read operations do not select candidate programs or trust/install anything. They are not a replacement for private canonical Git-review metadata, nor proof against concurrent same-user changes, local metadata influence, alternates or arbitrary same-user capabilities.

`preflight:70–114` refuses new configuration names in root/apps ancestry and recursively in the pipeline, including ignored config names, hidden `.config/mise`, symlink config ancestry and nonignored untracked pipeline inputs. It verifies the actual workspace-manifest set. My independent immutable path inventory matches the ten tracked discovery names in this scope; the separately pinned sibling manifest supplies the eleventh allowed discovery entry. No new configuration/discovery bypass is selected. Dependency/build output directories are deliberately pruned; their content is not source attestation.

### Two-file trust

Only the reviewed regular files below enter `MISE_TRUSTED_CONFIG_PATHS` in either wrapper, and only these exact two absolute names are passed to setup's trust commands (`setup:60,75–76`; `test:62`):

```text
$checkout/mise.toml
$checkout/apps/issue-pipeline/mise.toml
```

There is no directory-wide trust, ambient trusted list, `MISE_YES`, config-root amendment, third trust file or automatic missing-file skip. Stdin closes for delegated commands. Full-file regular/ancestor checks matter because the documented mise trust setting uses path prefixes rather than an exact-equality API. Setup's trust state resides in its owned temporary mise state, not operator HOME.

The sibling TOML remains SHA-256 `1a83daf451f50c1788c9452251ce723fe1bdd59bba00cb0266ca517382624443`, informational and **not trusted**. Root `config_roots` still names both apps. Sibling presence alone is not an introduced defect, but static ancestry checks do not prove mise's effective enumeration/loading. No mise executable or discovery command ran. A third config actually required or loaded must stop for exact-path/hash review and parent disposition, not trigger auto-yes, a trust-prefix expansion or discovery override.

### Tool and environment isolation

The wrappers require provisioned Node `24.21.0` and exact mise version string `2026.9.4 macos-arm64 (2026-09-09)`, using the named operator tool paths. Setup additionally names the provisioned npm CLI and asserts `11.19.0`; none of those assertions ran here. No fallback/shim download is supplied.

The delegated environment retains owned short `/tmp` directories, isolated HOME/ISSUE_PIPELINE_ROOT/mise/XDG roots, EXIT cleanup, refusal stubs for gh/pi/curl/wget, global/system Git isolation and file-only Git transport. Mise is offline with automatic installation disabled. Test npm remains offline. No ambient token, proxy, modelEnv, `.env` loader or operator trust is passed into the delegated environment. The test wrapper's inherited tool/temp/mock recipe and task sequence survive the exact regenerated v3 delta.

These are environment and command fences, **not an operating-system filesystem/network sandbox**. Dependency code, selected production CLIs and any explicit full tests still execute under the same user if later authorized. Provisioned binaries/dependencies are not authenticated by the seventeen source hashes. Missing delegated offline tools must refuse, not download, repair or choose another actor.

### Registry-only setup proposal

The prospective network decision is limited to normal locked public npm retrieval in this setup proposal. It grants neither adoption nor execution. `setup:11–29` preflights before version probes, temporary state, both trust commands and `ci`; `setup:45–78` supplies separate empty user/global npm configs, empty owned cache/HOME, exact public registry, strict TLS, disabled scripts/audit/fund/update notification and fetch retries zero. The CLI directly runs under the pinned Node. There is no mandatory prepopulated cache and no project lifecycle-script selection.

I independently parsed the pinned lock, not an author assertion. It has 161 records: root plus two workspaces, 156 public HTTPS `registry.npmjs.org` tarball entries and two exact local workspace links. Every remote entry has no credentials/query/fragment or parent traversal and has syntactically valid 64-byte SHA-512 integrity. The complete derived remote inventory equals `O/reviewed-public-npm-lock-inventory.json`. Both vectors use lock SHA-256 `ce07af1836fea8cef08e5162144b8790893ec4cc04b1232e38369e2d2a719b4c`. No Git/private/arbitrary source dependency is selected. Install-script metadata is not permission to run scripts: `--ignore-scripts` is retained.

Registry/TLS/redirect handling and the provisioned npm implementation remain external trust assumptions. The proposal is not a socket-level destination allowlist; no network request, TLS check, tarball verification, npm invocation or provisioning ran in this review. The npm-only allowance does not become test or mise provisioning authority.

## Fast and explicit full semantics

The test wrapper calls only the actual individual `typecheck`, `lint` and `build` tasks, in that order (`test:69–71`). It never delegates to the old broad `check` on #164. It then checks syntax for exactly ten inputs (`:72–76`): `install.mjs` and all nine dist programs, including `structured-output.mjs`.

The common prerequisite contains one bounded invocation (`:77`):

```bash
node --test --test-concurrency=2 --test-timeout=180000 test/build.test.mjs test/check-task.test.mjs
```

Fast stops after that prerequisite. Only explicit `full-v4` adds the unchanged full selection (`:84`):

```bash
node --test --test-concurrency=2 --test-timeout=180000 'test/**/*.test.mjs'
```

The wrapper's double quotes and task's single quotes both pass one literal glob argument. Full retains concurrency 2 and timeout 180000 and runs after the same prerequisite. Both bounded files run again through the glob; repetition is not additional unique coverage. #164 has no source `check:full` task; this external wrapper supplies its own explicit full recipe without inventing a #164 source change. Corrected #178 retains `depends = ["check"]` and that same full argv.

I read both genuine guard variants. #164's old `CHECK_TASK`/timeout case checks one terminated old check table and a positive timeout (`inspection/164/.../check-task.test.mjs:19–47`); #178's `CHECK_TASKS` case requires exactly two terminated check/full tables, each with a positive timeout (`reviewed-variants/eco178-f1-f2-f3-v4/.../check-task.test.mjs:19–50`). The corresponding actual TOMLs meet those static predicates. Neither guard asserts equality to 180000; the pinned task/wrapper literals supply that exact value.

Both retain the real compiler regression: a temporary unannotated fixture must produce TS2345, then a corrected numeric call must compile successfully under the actual inherited checked-JavaScript config, using the resolved real TypeScript compiler, 60000 ms subprocess bounds and cleanup. The identical build guard builds into a temporary directory, checks all nine executables, parses artifacts, exercises real CLI refusals and local bare-Git/fake-GitHub orchestration, and imports the built extension factories. Its helper closure uses private fake credentials/GitHub/transport; it is not actual project authority.

No assertion, timeout, skip, todo, test removal or source check-task rewrite was introduced by these wrappers. Passing later fast execution would not prove full-flow, runtime authority, recovery, isolation, merge safety, browser/server or end-to-end behavior. No fresh test count, timing or savings is established here.

## Installed-source startup and correction proof

This section resolves the author report's setup-timing question as far as immutable installed code permits. I independently compared the cited supporting files with actual `684473c` Git objects, including the additional role-input/session/PR source files in final closeout. It is not a fresh installed-binary or live-config attestation.

1. **Checkout precedes claim for every selected stage, including Review.** `P/src/job.ts:94–105` resolves the role then calls `openJobCheckout`; that function (`job/checkout.ts:80–112`) creates the stage's full repository checkout on its assigned branch and updates submodules. It does not call configured setup. `job.ts:121–129` frames ops with that checkout. `job/ops-request.ts:33–45` carries the mapping and policy digest. `ops.ts:132–149` loads config, applies `withCheckout`, checks the digest, then dispatches. `config.ts:100–109,175–180` makes `paths.worktree` resolve to this job checkout for the issue.
2. **Claim distinguishes no-slot/precreated from lane-slot startup.** `ops/claim.ts:97–116,161` observes the already-existing `.git`; `checkouts.ts:77–96` returns that checkout rather than creating another. `ops/claim.ts:229–241` runs legacy configured setup only when `!existed && laneSlots === undefined`. It separately saves authority and runs configured setup for every unfinished lane-slot claim at `:244–248`. This branch has no exception for Review or a requirements-only return. `checkouts.ts:266–284` calls configured setup; `lane-slots.ts:128–163` makes a failed lane setup fatal and retains pending readiness.
3. **Review's requirements guard occurs before its writer and verifier.** `job/role-run.ts:198–225,252–259` must first obtain a successful claim and matching saved stage. `runClaimed` (`:157–171`) reads inputs, checks branch movement, then calls the role. `job/role-inputs.ts:25–42` reads the claim snapshot; it runs no setup. Reviewer entry (`roles/reviewer/reviewer.ts:265–270`) first reads `currentRevision`, then calls `notHardenable`. `revision.ts:171–203` reads current inputs/PR/checkout/target and policy; it does not run configured checks. `reviewer.ts:39–60` returns changed requirements before hardening. For direct-mode work, `requirements.ts:11–35,49–72` returns to implement and refuses a Developer return over retained merge/attempt evidence. A policy change alone is not an inputs mismatch.
4. **Implementation can correct before configured verification on the same no-slot path.** `roles/implementor/implementor.ts:165–182` checks retained evidence and trusted requirements, then develops. `:122–153` starts/fills the draft PR and runs the Developer writer before pushing the resulting branch and saving review. `ops/pr.ts`'s actual start/open handlers use checkout/PR/push operations, not configured setup/checks. No role-session/session-hook setup was found. Developer must commit the reviewed task/guard vector before choosing setup or tests; a merely edited working file cannot pass the preflight.
5. **Actual hardening and verification require corrected bytes.** After the guard, `reviewer.ts:173–197` runs the hardening writer and `verifiedHead`; `roles/verification.ts:45–55,129–141` invokes the verify op. `ops/checks.ts:136–155` runs configured setup before test/lint/typecheck. Thus no-slot Review1 can return requirements on raw #178, and a later no-slot Implementation2 can commit corrections before Review2's configured setup is required. Any voluntary earlier setup by the Developer would correctly refuse raw bytes and is not needed to establish this source route.

**Conclusion:** there is a normal source-supported no-slot route through Review1 → Implementation2 → Review2; v4's refusal of raw app hash `25d0e40d7b18ce56dd7d47a358aa65345cac88f7b0670e295433380b68252f35` does not force adding a third variant or skipping mandatory setup. This is conditional reachability, not evidence that the current live route meets its conditions. The active laneSlots setting, readiness store, saved authority, actual current inputs/branch/target, model instructions and resource/capacity prerequisites remain parent-owned. Historical no-slot reports do not authenticate today's config.

If laneSlots is active, raw #178 hits the shared preflight during claim before Reviewer can return requirements or Developer can correct it. Then this proposal alone cannot authorize continuation. Stop for parent-reviewed routing/policy resolution; do not start to demonstrate the failure, disable lane protection, force Implementation, use old setup, or silently trust a third raw variant.

## Prioritized findings and minimal dispositions

### P2-1: Active setup path is a concrete phase prerequisite, not a new hash defect

**HOLD on an unconditional #178 phase-readiness claim; conditional source-route PASS as proved above.** The author correctly excludes raw #178 (`author report:104`), but leaves actual timing to reconciliation. Installed source now narrows the answer: no-slot/precreated Review can return first; lane-slot claim cannot. The review did not open live operator configuration or readiness stores and cannot certify which branch will execute.

**Minimal disposition:** parent must establish the actual normal startup path and retained readiness before any phase grant, without running a phase/setup as a probe. If the supported no-slot path applies, retain this proof and require genuine consolidated requirements plus committed corrections before configured checking; no proposal-byte change is required for that fact alone. If setup is mandatory on raw bytes, hold #178 for an explicitly reviewed lawful resolution. Do not silently widen the profile or bypass setup. This limitation does not invalidate #164's matching existing vector.

### P2-2: Mise effective scope and provisioned resolution remain unrun

**HOLD on runtime/adoption readiness, not a finding that sibling presence grants trust or is itself forbidden.** The exact two trust files and task arguments are reviewable and preserved; their effective loading/delegated offline tool resolution has not been exercised. See `setup:54–62`, `test:56–62` and root config roots.

**Minimal disposition:** retain the two-file constraint and establish actual effective scope/provisioning only under separate parent authorization, before spending a constrained canonical phase. A third actually loaded/required config needs independent exact-path/hash review and parent disposition. Do not trust it, auto-answer or change discovery to suppress refusal. Missing tools do not authorize downloads or fallback.

### P2-3: External artifact identities require separate adoption binding

**HOLD on treating compatibility or a command-string digest as whole-source/policy approval.** `P/src/project-policy.ts:156–192` binds effective settings and committed policy provenance where configured, not the external wrapper/preflight/profile bytes. A seventeen-input match cannot authenticate the complete corrected source, trusted requirements, target or retained state. Neither fixture authority nor the uncommitted correction packet supplies those facts.

**Minimal disposition:** parent adopts both new versioned command strings through the actual configured legacy or committed policy authority, with independently retained exact four artifact hashes and normal jobs/test-consumer drain. In committed mode do not use flat overrides. Obtain the real native effective digest; do not invent one here. At actual checks/Hardening/Security/Land bind the complete source commit/tree, canonical trusted-input revision, current effective policy and literal target branch/full observed target commit. Any new selected-policy/config/helper byte needs a newly identified independent review, not a checksum refresh under this identity.

There is no newly established defect requiring edits to the four frozen proposal files in this review. These P2 holds distinguish missing operational proof from introduced code defects. All four artifacts and prior reports remain unchanged.

## Canonical and installation limits

#164's vector matches its actual cleanup without adding #178 source requirements. Its installed Review guard compares trusted inputs for a requirements return, not policy alone. Retain the original route report's **no Implementation left, one Review left** constraint: only a truthful, canonically authenticated unchanged-requirements policy-only Review can use that remaining opportunity. If a real new requirement is needed, stop before consuming the final Review on a known exhausted Implementation return. Neither this review nor the profile creates phase capacity.

#178's nominal Review1 → Implementation2 → Review2 route still consumes its remaining opportunities. No extra hardening capacity is created for later source/requirements/target movement. Corrected #178 plus F3 is not standalone installable: the separate #185/#144 pre-Land-only safety implementation must survive actual source reconciliation. Do not replace accepted installed safety with documentation saying the behavior should exist.

Installation remains separate: exact authorized pre-Land fast checks and independent read-only Security on the same source/input/policy/target; authenticated delivery identity/receipt/ancestry; separately authorized dry-run, backups, job and test-consumer drain, controlled cutover, managed-artifact comparisons and bounded installed-CLI acceptance. Full is explicit pre-Land opt-in, not a default or installation prerequisite. After Land, confirm existing exact proof read-only; no fresh suite, Security model, repair writer or remerge may supply missing proof. Missing/stale/mismatched premerge proof is STOP. Authorized evidence checkpoints and finish bookkeeping remain distinct.

Preserve installed `684473c2fc14f0510ffc0a6749570f2e0f49733a`, disabled CI, PB511/PB512 exclusions, stopped177, separate187/108, PID88384 and every old failure. Prospective consent does not authorize the historical #178 trust override or authenticate its later observations. Old #164 checks are not checks on today's cleanup. No live process/lease was inspected or disturbed.

## Actual validation and preservation

Actual work used read/list/grep tools, my own `/usr/bin/python3 -I -S` inline analysis, and read-only absolute `/usr/bin/git` object/tree/ref/index queries with lazy fetch/optional locks/global/system config disabled. I independently checked inventory hashes, immutable inspection copies, six-path/fourteen-hunk reconstruction, all 34 profile records, complete final F3 manifest identities, two shell deltas, discovery/workspace sets, all 156 registry integrity entries and installed call-order source identities. Standard-library `ast.parse` parsed only the shared Python and both bootstraps.

The saved author syntax evidence records one `/bin/bash -n` per final frozen shell, exit 0 and empty output on the exact hashes above. I verified its binding as data. **I ran no new Bash syntax check** and do not promote that recorded syntax result into wrapper/runtime proof.

One own combined data-inspection command completed every artifact/vector/patch/lock/AST/delta/source comparison, then exited 1 while trying to read `S/.git/index`: `NotADirectoryError: [Errno 20] Not a directory`. S is a linked worktree. A separate metadata-only closeout resolved the index with Git's absolute `--git-path index`; no proposal or canonical action was retried. Two source-read path mistakes also returned errors: a lane-slots offset beyond its 264 lines, and nonexistent `ops/start-pr.ts`; actual source discovery/read established `ops/pr.ts`. These are disclosed inspection errors, not tests or suppressed runtime failures.

**Not run:** author verifier/generator/preflight/bootstrap, wrappers or argument probes, mise/Node/npm/version/task/discovery/trust/setup, dependency/network provisioning, new Bash syntax, source imports/programs, types/lint/build/tests/full suite, browser/server/e2e, live-model/service/production calls, canonical status/claim/start/Implementation/Review/Security/Land/Completion, policy loading/application, installer dry-run/install or acceptance. No live operator JSON, `.env*`, modelEnv, actual credential or runtime-secret content was read. The fake credential helper's source is test data only.

R remained at HEAD `c3134206c0e94fa81b53c6dde1d14bc9b2877cb7`; its index SHA-256 at observations was `321f931cb584abb0d9ba0d6bf1d484d1c6c52c3ff4dc580082555661b2ee5530`; `show-ref` output SHA-256 was `a6d8d2f7636d420768cec83984e4b473e95484e62054adf480b9b75a526c46f2`; cached name-only diff was empty. S's HEAD is installed `684473c`; its actual linked-worktree index hashes to `17265715852110556d766e6569e0a16c2f1f28dd1eedb2e10007f40f5aed2dd2` and cached name-only diff is empty. This is scoped observer evidence, not certification of a different checkout or global quiescence. Nothing was staged.

Final closeout rechecked all 74 inventoried artifact hashes, both observer indices/HEADs/refs and empty cached path lists; all remained unchanged. The report's structured acceptance block parsed as JSON. Only this assigned report was written. No source/index/object/ref, original artifact/report, operator config/script/trust, state/receipt/limit/lease/counter/stop or installation changed. No network, background consumer, reservation, fanout, forced stage, reset, stopped-action retry or alternate actor was used. All own data consumers ended synchronously.

**Recommended next step:** parent may retain this scoped byte/recipe pass. Resolve the named active startup-path, effective mise scope/provisioning and actual policy-adoption bindings before separately authorizing any continuation. Do not commission a speculative phase to test the raw #178 mismatch, and do not block #164's compatible policy-only path solely because #178 still needs its own current-route proof.

```acceptance-report
{
  "criteriaSatisfied": [
    {"id":"criterion-1","status":"satisfied","evidence":"Fresh independent read-only review; only the assigned report written. Four immutable artifacts, both complete vectors, actual correction recipe and installed Review/Implementation/setup order inspected without executing proposal/source or changing authority."},
    {"id":"criterion-2","status":"satisfied","evidence":"Exact hashes/provenance, all74 inventory comparisons, all34 vector records, six-path/fourteen-hunk reconstruction and final manifest comparisons, installed call-order citations, scoped priorities/minimal dispositions, explicit unrun limits and observer-index evidence recorded."}
  ],
  "changedFiles": ["/Users/axolotl-logic/workspace/agent-handoffs/project-buddy/20261019-launch-ready/dispatch-20261022-four-lane-drain/ecosystem-v4-policy-independent-review.md"],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {"command":"Read/list/grep and own /usr/bin/python3 -I -S inline immutable-data analysis with read-only /usr/bin/git object/tree/ref/index queries","result":"passed","summary":"Actual inspection-copy identities, all74 inventory hashes, six-path/fourteen-hunk correction, all34 vector records, final12-record correction manifest, exact shell deltas, discovery/workspaces and156 registry integrities matched."},
    {"command":"Own combined inline data analysis final direct S/.git/index read","result":"failed","summary":"All preceding comparisons completed; final observer read raised NotADirectoryError because S is a linked worktree. No proposal/canonical launch occurred or was retried; separate metadata closeout resolved the actual index path."},
    {"command":"Read-only metadata closeout with git rev-parse --path-format=absolute --git-path index and cached name-only diff","result":"passed","summary":"R HEAD/index/refs unchanged; R and S cached paths empty. S's actual linked-worktree index identified and hashed."},
    {"command":"Own standard-library ast.parse on shared preflight and both embedded bootstrap texts","result":"passed","summary":"Syntax parsing only; no proposal/preflight/source import or execution."},
    {"command":"New Bash syntax, wrappers/preflight/author programs, Node/mise/npm/setup/tasks/tests/network/canonical/adoption/install execution","result":"not-run","summary":"Forbidden in this review. Existing final frozen shell syntax records inspected as data only; no authenticated gate or runtime-readiness result claimed."}
  ],
  "validationOutput": [
    "Frozen fast295311a8, setupb352942e, preflight18235e0c and profilee1ba88f7 hashes match in full as recorded above.",
    "Two complete17-input vectors match actual164 and reconstructed178; only app TOML and genuine check-task guard differ; other15 identical.",
    "Raw17825d0e40d is not an allowed variant. Installed no-slot/precreated Review returns requirements before hardening/verify; lane-slot claim instead runs setup first and would refuse raw bytes.",
    "Ten syntax inputs; both real bounded guards once in common prerequisite; explicit full literal glob/concurrency2/180000 unchanged and duplicates both files.",
    "R index321f931cb584abb0d9ba0d6bf1d484d1c6c52c3ff4dc580082555661b2ee5530; no staged paths in R or S."
  ],
  "residualRisks": [
    "P2 active startup setting/readiness and saved canonical authority remain unobserved; no unconditional178 phase-readiness claim.",
    "P2 mise effective sibling loading/delegated offline tool resolution and actual provisioning remain unrun; two exact trust files only.",
    "P2 real policy adoption/digest plus separate external artifact hashes and full source/input/current-target binding remain parent-owned.",
    "Same-user command/environment fences are not an OS sandbox; provisioned binaries, npm registry/TLS/redirect behavior and dependencies remain external assumptions.",
    "No spare phase capacity, historical authorization repair, Security, safety-port reconciliation, Land or installation/acceptance proof supplied."
  ],
  "noStagedFiles": true,
  "diffSummary":"One new independent proposal review report. Scoped byte/recipe PASS; precise adoption/readiness HOLD conditions and conditional installed-source correction route, with all immutable subjects unchanged.",
  "reviewFindings": [
    "No introduced P1 bypass or correctness defect established within this static review.",
    "P2-1: ops/claim.ts:229–248 and reviewer.ts:39–60,265–270 distinguish no-slot precreated return from lane setup-before-role; active path must be established before178 start.",
    "P2-2: setup/test isolated mise scope is unexecuted; no third-config trust or discovery bypass authorized.",
    "P2-3: project-policy.ts:156–192 does not hash external wrapper bytes; actual parent adoption and complete canonical bindings required."
  ],
  "manualNotes":"Review gate remains parent-owned. This is not canonical Review/Security, an executed check, policy adoption, publication, phase permission or installation acceptance. Preserve installed684473c, disabled CI, exclusions/stops, PID88384, budgets and all historical failures."
}
```
