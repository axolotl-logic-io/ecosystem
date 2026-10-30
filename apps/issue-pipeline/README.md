# Legacy source commands

Distribution is owned by the repository's `build.ts`, `install.ts` and
`programs.ts`. Use `npm run build`, `npm run install:dry-run` and
`npm run install:runtime` from the repository root.

This directory is no longer an application or npm workspace. Its `build.ts`,
`install.ts` and mise install tasks forward existing operator commands to the
root distribution. They contain no task or runtime implementation.

The [issue host](../issue-host/README.md) provisions the GitHub issue adapters.
[Tasks](../../docs/README.md) own their domain behavior, the
[launcher](../launcher/README.md) runs one buddy, and the
[orchestrator](../orchestrator/README.md) supervises launchers.
See [operations](../../docs/reference/operations.md) for drain, install,
restart and rollback. Merging source activates nothing.
