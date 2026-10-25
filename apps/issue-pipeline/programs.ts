// One distribution manifest for the build, installer and syntax gate.
export const PROGRAMS = [
  { source: "scripts/safe-refactor.ts", file: "safe-refactor.mjs" },
  { source: "src/safe-refactor/tool.ts", file: "safe-refactor-tool.mjs" },
  { source: "src/job/git-review.ts", file: "git-review.mjs" },
  { source: "src/ops.ts", file: "ops.mjs" },
  { source: "src/shell-supervisor.ts", file: "shell-supervisor.mjs" },
  { source: "src/buddy.ts", file: "buddy.mjs" },
  { source: "src/report.ts", file: "report.mjs" },
  { source: "src/job/structured-output.ts", file: "structured-output.mjs" },
  { source: "src/job/pipeline-commit-tool.ts", file: "pipeline-commit.mjs" },
  { source: "scripts/standards-upgrade.ts", file: "standards-upgrade.mjs" },
] as const;

export const RETIRED_PROGRAMS = [
  "job.mjs",
  "orchestrate.mjs",
  "caller-jobs.mjs",
  "sweep.mjs",
] as const;
