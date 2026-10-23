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
- **Fix a known flake first, on its own,** before other work that would trip on it. A flake left open costs a run in every branch that meets it.
- **Test behaviour through a real dependency or the whole system.** Tests exercise behaviour through a real dependency, such as the filesystem, a database, a browser or a subprocess, or through the whole system. Integration and feature-entrypoint tests, including browser-mode component integrations, are valid; a test need not cover a whole application flow. Don't write unit tests: tests that import a module and call it directly without a real dependency. Reading a module to load it isn't a filesystem-backed test; a filesystem guard validates actual artifacts. Don't repeat at a higher level what a lower level already proves. The project practices name each repository's levels.
- **Test a feature or reproduce a bug, not an implementation.** A test checks behaviour that a user or caller relies on, or reproduces a bug that was fixed. It doesn't pin private helpers, call order, internal state or wording that nothing relies on.
- **No tautological tests.** A test that can't fail while the code is wrong proves nothing: one that checks a mock returns what it was given, compares a value with itself, or re-proves the language or framework. Delete it, or rewrite it to check an outcome.
- **Tests don't need frequent maintenance.** A refactor that keeps behaviour breaks no test. A test that breaks on most changes to its subject is testing the implementation; rewrite it against the outcome.
- **No sleeps; mock time.** A test never waits a fixed time for something to happen. Code that waits or reads the clock takes its clock or delay as a parameter, so tests pass a fake one or use the test runner's fake timers. A test that waits for an event awaits the event itself, such as a promise, a process exit or a file, never a delay. A subprocess, which fake timers can't reach, gets short durations through its configuration.
- **Reuse the test kits.** Before writing a helper, fixture or fake, look in `test/` for one, and extend it rather than writing a copy.
- **Keep tests fast.** Each test makes its own data. Share only read-only set-up within a file, and run independent set-up together.
- **Code only tests use lives with the tests, not in `src/`** (`test-code-in-test`): `src/` holds only what the program runs. Tests and their helpers are in `test/`, in the folder their subject has under `src/`, so the tests for `src/storage/store.ts` are `test/storage/store.test.ts`. Helpers are named `fake-*.ts`, `*-fixtures.ts` or `*-test-kit.ts`, such as `test/http/fake-fetch.ts`, which answers requests from a stubbed `fetch`.

## Secrets

Never print a `.env*` file. Never copy a secret into code, docs, logs, issues or commits.
