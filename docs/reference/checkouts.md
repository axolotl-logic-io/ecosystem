# Checkouts

Task apps use private checkouts for each run. A shared local mirror supplies Git objects; a local mirror mutex serializes fetches and Git metadata updates. It is not a work claim or a task reservation.

## Layout

Under `$ECOSYSTEM_DATA_ROOT`, `clones/SLUG/` and `work/SLUG/mirror.git` hold fetched repositories, `work/SLUG/jobs/` holds private writer checkouts and `runs/SLUG/issue-N/` holds task-run observations, session transcripts and recovery files. `SLUG` replaces the repository's `/` with `__`.

Gherkin uses a detached base checkout. Verify uses a detached PR-head checkout and retains it if checks change tracked files. Implement and Fix start from the issue branch's pushed head, or from the base when the branch does not exist.

## Preservation

A failed or stopped writer keeps its checkout. Successful cleanup preserves uncommitted patches and bundles local commits before removing a disposable checkout; failed preservation keeps it. Pushes only fast-forward the issue branch. A diverging push preserves the run's work on its own recovery branch.

Task apps do not run `commands.teardown`; writers refuse a config that sets it.

## Recover a retained checkout

Preserve its index, untracked files and commits before moving anything. Compare its history with the issue branch and PR on GitHub. Publish missing work through ordinary reviewed Git practice, then apply the appropriate start label. There is no checkpoint adoption or `recover-implement.mjs` command.
