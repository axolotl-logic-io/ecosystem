# Project practices

These are the repository's design, type, lint, test and secrets rules. The root [`AGENTS.md`](../AGENTS.md) links here.

## Design

Follow John Ousterhout's *A Philosophy of Software Design*:

- **Deep modules:** small, simple interfaces over substantial functionality. No pass-through methods, no thin wrappers that only rename, no classes that exist only to hold one call.
- **Information hiding:** each design decision lives in exactly one module, for example a storage layout, a wire format or an error classification. Callers don't know the schema, the provider or the format.
- **Pull complexity downward:** a module handles its hard cases itself rather than pushing them to callers through options or extra steps.
- **Define errors out of existence:** prefer interfaces with no error case. An unknown or malformed id is "not found" (`undefined`), not an exception; deletes are idempotent.
- **Different layer, different abstraction:** layers each speak their own vocabulary. Avoid temporal decomposition, which splits code by the order things happen rather than by the knowledge they hide.
- **Somewhat general-purpose:** interfaces fit today's needs without baking in one caller's special case.
- **Comments:** interface comments say what a module does and promises, not how. Implementation comments explain only what the code can't. Names are precise and consistent across the codebase.
- **Strategic, not tactical:** leave the code a little better designed than you found it.
- **A change is complete:** it updates the tests and docs it affects. Build on useful existing work instead of restarting.

## Types

- No `any`, no non-null `!`, and no `as` casts except at one validated boundary.
- Parse external data at the boundary with zod and use the parsed types inside it.
- Domain ids get their own types where they could be mixed up.

## Lint

- **No dodges:** satisfy a rule through better design, never through tricks that slip past it, such as computed keys, bracket reads or `process.getBuiltinModule`. Never weaken a test, check, lint rule or type to get a pass.

### Patterns the rules force

- Regexes are top-level, named and use the `u` flag.
- Parameter and return types are explicit; interfaces use property-style signatures; exports come last in a file; keys from an index signature are read by destructuring.
- No ternaries. No `void` on promises.
- `noSecrets` flags long camelCase identifiers in strings, so a `describe` names the behavior or command, not a long function name.

## Tests

Tests are sorted by the ISTQB (CTFL v4.0) test levels. A test lives in `test/<level>/`, under the path its subject has, so `test/system/runtime/buddy-flow.test.ts` is a system test of the runtime. A helper that more than one level uses lives in `test/support/`. [Writing a test](../apps/issue-pipeline/test/README.md) says what each level fakes, which kit to start from and how to run it.

| Level | Tests | Folder |
| --- | --- | --- |
| Component | one component on its own | `component/` |
| Component integration | components together, or one with a real dependency such as Git, the filesystem or a subprocess | `component-integration/` |
| System | the whole built program: buddy flows against fake GitHub and fake pi, CLI entrypoints, built artifacts | `system/` |
| System integration | the program against real GitHub or a real model; opt-in, not in `check:full` | `system-integration/` |
| Acceptance | an issue's Gherkin scenarios, one test each, run against the system | `acceptance/` |

- **A flake is a failure**. Fix the cause or the measurement; never rerun until it passes. A passing repeat adds no evidence, and no test may depend on timing.
- **Fix a known flake first, on its own,** before other work that would trip on it. A flake left open costs a run in every branch that meets it.
- **Test a feature or reproduce a bug, not an implementation.** A test checks behavior that a user or caller relies on, or reproduces a bug that was fixed. It doesn't pin private helpers, call order, internal state or wording that nothing relies on.
- **No tautological tests.** A test that can't fail while the code is wrong proves nothing: one that checks a mock returns what it was given, compares a value with itself, or re-proves the language or framework. Delete it, or rewrite it to check an outcome.
- **Tests don't need frequent maintenance.** A refactor that keeps behavior breaks no test. A test that breaks on most changes to its subject is testing the implementation; rewrite it against the outcome.
- **No timed waits; mock time.** A test never sleeps or polls on a timer for something to happen. It awaits the event itself, such as a promise, a process exit, a file change or a FIFO. Code that waits or reads the clock takes its clock or delay as a parameter, so tests pass a fake one. A subprocess, which fake timers can't reach, gets short durations through its configuration. A deadline may only fail a test, never pace it.
- **Fake services are long-lived servers.** A fake external service, such as GitHub, runs as one server per test machine, and the program reaches it the way it reaches the real one. Don't start a process for each call.
- **Tests clean up.** A test stops every process it starts and puts a deadline on every wait.
- **Reuse the test kits.** Before writing a helper, fixture or fake, look in `test/` for one, and extend it rather than writing a copy.

## Secrets

Never print a `.env*` file. Never copy a secret into code, docs, logs, issues or commits.
