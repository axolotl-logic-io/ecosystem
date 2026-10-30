// Persistence format of a submitted Verify review, hidden from task decisions.
function reviewArtifact(
  execution: string,
  body: string,
  counts: { blocking: number; nits: number; security: boolean },
): string {
  return `${body}\n\n<!-- agent-pipeline:verify-review\n${JSON.stringify({ run: execution, ...counts })}\n-->`;
}

export { reviewArtifact };
