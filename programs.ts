// One distribution manifest for the build, installer and syntax gate.
export const PROGRAMS = [
  { source: "apps/issue-pipeline/src/task-apps/fix.ts", file: "fix.mjs" },
  { source: "apps/issue-pipeline/scripts/safe-refactor.ts", file: "safe-refactor.mjs" },
  { source: "apps/issue-pipeline/src/safe-refactor/tool.ts", file: "safe-refactor-tool.mjs" },
  { source: "apps/issue-pipeline/src/job/git-review.ts", file: "git-review.mjs" },
  { source: "apps/issue-pipeline/src/shell-supervisor.ts", file: "shell-supervisor.mjs" },
  { source: "apps/issue-pipeline/src/buddy.ts", file: "buddy.mjs" },
  { source: "apps/launcher/src/cli.ts", file: "launcher.mjs" },
  { source: "apps/orchestrator/src/cli.ts", file: "orchestrator.mjs" },
  { source: "apps/issue-pipeline/src/gherkin.ts", file: "gherkin.mjs" },
  { source: "apps/issue-pipeline/src/task-apps/implement.ts", file: "implement.mjs" },
  { source: "apps/issue-pipeline/src/job/structured-output.ts", file: "structured-output.mjs" },
  { source: "apps/issue-pipeline/src/job/pipeline-commit-tool.ts", file: "pipeline-commit.mjs" },
  { source: "apps/issue-pipeline/scripts/standards-upgrade.ts", file: "standards-upgrade.mjs" },
  { source: "apps/issue-pipeline/src/task-apps/verify.ts", file: "verify.mjs" },
  { source: "apps/issue-pipeline/src/task-apps/land.ts", file: "land.mjs" },
] as const;
