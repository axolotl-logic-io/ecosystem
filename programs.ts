// One distribution manifest for the build, installer and syntax gate.
const PROGRAMS = [
  { source: "apps/issue-host/src/task-apps/fix.ts", file: "fix.mjs" },
  {
    source: "apps/issue-host/scripts/safe-refactor.ts",
    file: "safe-refactor.mjs",
  },
  {
    source: "apps/issue-host/src/safe-refactor/tool.ts",
    file: "safe-refactor-tool.mjs",
  },
  { source: "apps/issue-host/src/job/git-review.ts", file: "git-review.mjs" },
  {
    source: "apps/issue-host/src/shell-supervisor.ts",
    file: "shell-supervisor.mjs",
  },
  { source: "apps/issue-host/src/buddy.ts", file: "buddy.mjs" },
  { source: "apps/launcher/src/cli.ts", file: "launcher.mjs" },
  { source: "apps/orchestrator/src/cli.ts", file: "orchestrator.mjs" },
  { source: "apps/issue-host/src/gherkin.ts", file: "gherkin.mjs" },
  {
    source: "apps/issue-host/src/task-apps/implement.ts",
    file: "implement.mjs",
  },
  {
    source: "apps/issue-host/src/job/structured-output.ts",
    file: "structured-output.mjs",
  },
  {
    source: "apps/issue-host/src/job/pipeline-commit-tool.ts",
    file: "pipeline-commit.mjs",
  },
  {
    source: "apps/issue-host/scripts/standards-upgrade.ts",
    file: "standards-upgrade.mjs",
  },
  { source: "apps/issue-host/src/task-apps/verify.ts", file: "verify.mjs" },
  { source: "apps/issue-host/src/task-apps/land.ts", file: "land.mjs" },
] as const;

// Task definitions own prompts and agent templates; installed names stay stable.
const TASKS = ["gherkin", "implement", "fix", "verify", "land"] as const;
const ASSETS = [
  { source: "tasks/verify/prompts/verify.md", file: "prompts/verify.md" },
  { source: "tasks/gherkin/prompts/gherkin.md", file: "prompts/gherkin.md" },
  { source: "tasks/fix/prompts/fix.md", file: "prompts/fix.md" },
  {
    source: "tasks/implement/prompts/developer.md",
    file: "prompts/developer.md",
  },
  {
    source: "tasks/implement/prompts/developer-hardening.md",
    file: "prompts/developer-hardening.md",
  },
  {
    source: "tasks/verify/agents/issue-pipeline-reviewer.md",
    file: "agents/issue-pipeline-reviewer.md",
  },
  {
    source: "tasks/gherkin/agents/issue-pipeline-gherkin.md",
    file: "agents/issue-pipeline-gherkin.md",
  },
  {
    source: "tasks/implement/agents/issue-pipeline-developer.md",
    file: "agents/issue-pipeline-developer.md",
  },
  {
    source: "apps/issue-host/agents/git-reviewer.md",
    file: "agents/git-reviewer.md",
  },
  { source: "apps/issue-host/repos/example.json", file: "repos/example.json" },
  {
    source: "apps/issue-host/runtime/pi-cliproxyapi-config.example.json",
    file: "runtime/pi-cliproxyapi-config.example.json",
  },
  {
    source: "apps/issue-host/src/standards/python-tools.txt",
    file: "standards-python-tools.txt",
  },
] as const;

export { ASSETS, PROGRAMS, TASKS };
