# Orchestrator

`@ecosystem/orchestrator` supervises one standalone launcher process per buddy.
It owns fleet validation and process lifecycle. Launchers own discovery and task
selection; task subprocesses retain claims, cancellation guards and recovery.

The version 1 operator-owned JSON configuration names absolute paths:

```json
{
  "version": 1,
  "buddies": ["/private/buddies/first.json", "/private/buddies/second.json"],
  "manifest": "/installed/issue-pipeline/tasks.json",
  "launcher": "/installed/issue-pipeline/launcher.mjs"
}
```

All entries are validated before startup. Duplicate buddy files, names or GitHub
accounts are refused, including accounts in different configuration folders.
Automatic restarts are disabled: each buddy starts at most once per orchestrator
invocation. Failed launchers are reported while healthy launchers keep running.
