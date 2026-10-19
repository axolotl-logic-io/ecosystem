# Agent rules

The repo is a monorepo (`monorepo-layout`): npm workspaces under `apps/`, with one `package-lock.json` at the root, and mise tasks in each app's `mise.toml`.

- `apps/issue-pipeline/` is the issue pipeline. Read its `README.md` before changing it: a merge changes nothing that runs until the operator installs it.

The code, test and lint rules below are carried over from project-buddy's root `AGENTS.md`; site-only rules do not apply. The root and pipeline Biome configs encode the lint policy and its documented process-boundary exceptions.

## Design

Follow John Ousterhout's *A Philosophy of Software Design*:

- **Deep modules:** small, simple interfaces over substantial functionality. No pass-through methods, no thin wrappers that only rename, no classes that exist only to hold one call.
- **Information hiding:** each design decision lives in exactly one module, for example the model choice, prompt assembly, the storage layout, error classification and the manual's URL scheme. Callers don't know the schema, the provider or the prompt text.
- **Pull complexity downward:** a module handles its hard cases itself rather than pushing them to callers through options or extra steps.
- **Define errors out of existence:** prefer interfaces with no error case. An unknown or malformed id is "not found" (`undefined`), not an exception; deletes and re-indexes are idempotent.
- **Different layer, different abstraction:** Different layers each speak their own vocabulary. Avoid temporal decomposition, which splits code by the order things happen rather than by the knowledge they hide.
- **Somewhat general-purpose:** interfaces fit today's needs without baking in one caller's special case.
- **Comments:** interface comments say what a module does and promises, not how. Implementation comments explain only what the code can't. Names are precise and consistent across the codebase.
- **Strategic, not tactical:** leave the code a little better designed than you found it.

## Types

- No `any`, no non-null `!`, and no `as` casts except at one validated boundary.
- Parse external data at the boundary with zod: request bodies, form data, env vars, JSON columns and model tool inputs. Inside the boundary, use the parsed types.
- Domain ids get their own types where mixing them up is possible, such as `ProjectId` and `ChatId`.

## Lint

- **Don't turn rules off.** Fix the code. Tests follow the same rules as other code; if code is hard to test, fix its interface.
- **No dodges:** satisfy a rule through better design, never through tricks that slip past it (computed keys, bracket reads, `process.getBuiltinModule`). No `biome-ignore`.

### Patterns the rules force

- Specs use `test`, not `it`. `noSkippedTests` and `useExpect` forbid `test.fixme` stubs.
- Regexes are top-level, named and use the `u` flag.
- Parameter and return types are explicit; interfaces use property-style signatures; exports come last in a file; keys from an index signature are read by destructuring.
- No ternaries. No `void` on promises.
- `noSecrets` flags long camelCase identifiers in strings, so a `describe` names the behaviour or command, not a long function name.

## Tests

- **A flake is a failure** (`flakes-are-failures`). Fix the cause or the measurement; never rerun until it passes. A passing repeat adds no evidence, and no test may depend on timing.
- **Code only tests use lives with the tests, not in `src/`** (`test-code-in-test`): `src/` holds only what the app runs. An app's tests and their helpers are in its `test/`, in the folder their subject has under `src/`, so the tests for `src/chats/store.ts` are `test/chats/store.test.ts`. Helpers are named `fake-*.ts`, `*-fixtures.ts` or `*-test-kit.ts`, such as `test/db/fake-neon-http.ts`, which runs the real Neon driver against a stubbed `fetch`.

Run `mise //apps/issue-pipeline:check` for the full gate. The pipeline README describes its isolated test setup.

## Secrets

Never print a `.env*` file. Never copy a secret into code, docs, logs, issues or commits.
