# Coding practices

These are the design, type, lint, test and secrets rules shared by every repository that keeps a copy of this page. Each copy is identical, so a change here goes into every copy. The root [`AGENTS.md`](../AGENTS.md) links here and to the repository's own project practices.

## Design

Follow John Ousterhout's *A Philosophy of Software Design*:

- **Deep modules:** small, simple interfaces over substantial functionality. No pass-through methods, no thin wrappers that only rename, no classes that exist only to hold one call.
- **Information hiding:** each design decision lives in exactly one module, for example a storage layout, a wire format or an error classification. Callers don't know the schema, the provider or the format.
- **Pull complexity downward:** a module handles its hard cases itself rather than pushing them to callers through options or extra steps.
- **Define errors out of existence:** prefer interfaces with no error case. An unknown or malformed id is "not found" (`undefined`), not an exception; deletes are idempotent.
- **Different layer, different abstraction:** Different layers each speak their own vocabulary. Avoid temporal decomposition, which splits code by the order things happen rather than by the knowledge they hide.
- **Somewhat general-purpose:** interfaces fit today's needs without baking in one caller's special case.
- **Comments:** interface comments say what a module does and promises, not how. Implementation comments explain only what the code can't. Names are precise and consistent across the codebase.
- **Strategic, not tactical:** leave the code a little better designed than you found it.

## Types

- No `any`, no non-null `!`, and no `as` casts except at one validated boundary.
- Parse external data at the boundary with zod and use the parsed types inside it.
- Domain ids get their own types where they could be mixed up.

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
- **Code only tests use lives with the tests, not in `src/`** (`test-code-in-test`): `src/` holds only what the program runs. Tests and their helpers are in `test/`, in the folder their subject has under `src/`, so the tests for `src/storage/store.ts` are `test/storage/store.test.ts`. Helpers are named `fake-*.ts`, `*-fixtures.ts` or `*-test-kit.ts`, such as `test/http/fake-fetch.ts`, which answers requests from a stubbed `fetch`.

## Secrets

Never print a `.env*` file. Never copy a secret into code, docs, logs, issues or commits.
