// One distribution manifest for the build, installer and syntax gate.
export const PROGRAMS = [
  { source: "scripts/safe-refactor.ts", file: "safe-refactor.mjs" },
  { source: "src/safe-refactor/tool.ts", file: "safe-refactor-tool.mjs" },
  { source: "src/job/git-review.ts", file: "git-review.mjs" },
  { source: "src/ops.ts", file: "ops.mjs" },
  { source: "src/database.ts", file: "database.mjs" },
  { source: "src/shell-supervisor.ts", file: "shell-supervisor.mjs" },
  { source: "src/buddy.ts", file: "buddy.mjs" },
  { source: "scripts/recover-implement.ts", file: "recover-implement.mjs" },
  { source: "src/job/structured-output.ts", file: "structured-output.mjs" },
  { source: "src/job/pipeline-commit-tool.ts", file: "pipeline-commit.mjs" },
  { source: "scripts/standards-upgrade.ts", file: "standards-upgrade.mjs" },
  { source: "src/task-apps/verify.ts", file: "verify.mjs" },
  { source: "src/task-apps/land.ts", file: "land.mjs" },
] as const;
