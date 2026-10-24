const implementorPrefix = /^implementor(?=-|$)/u;

/** Display labels only. Never use these to address a source run or session. */
function executionLabel(sourceKey: string): string {
  return sourceKey.replace(implementorPrefix, "developer");
}

/** Compatibility labels describe source stages, not observed task execution. */
function stageLabel(sourceStage: string): string {
  const labels: Record<string, string> = {
    author: "Author",
    implement: "Implementation",
    review: "Hardening",
    merge: "Legacy merge",
  };
  const { [sourceStage]: label } = labels;
  return label ?? sourceStage;
}

/** A mapping of responsibilities is not evidence of a current task or result. */
function taskCoverage(sourceStage: string): {
  tasks: string[];
  currentTask: null;
  evidence: string;
} {
  const mappings: Record<string, string[]> = {
    author: ["Author"],
    implement: ["Implementation"],
    review: ["Hardening"],
    merge: ["Sync", "Integration", "Security", "Land", "Completion"],
  };
  const { [sourceStage]: tasks } = mappings;
  return {
    tasks: [...(tasks ?? [])],
    currentTask: null,
    evidence:
      "Source stage mapping only; task, binding and current result are not observed.",
  };
}

export { executionLabel, stageLabel, taskCoverage };
