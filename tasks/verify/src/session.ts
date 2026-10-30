interface ReviewContext {
  repository: string;
  baseBranch: string;
  testCommand: string;
  issue: number;
  checkout: { repo: string; head: string };
  base: string;
}
const PHASE = "security-review";
function taskText(review: ReviewContext, issueFile: string): string {
  const { repository, baseBranch, testCommand, issue, checkout, base } = review;
  return [
    `# Issue #${issue} in ${repository}: \`${PHASE}\``,
    "",
    `- Task: \`${PHASE}\``,
    `- Issue file: \`${issueFile}\``,
    `- Code checkout: \`${checkout.repo}\`, detached at the reviewed head \`${checkout.head}\``,
    `- Target: \`${baseBranch}\` at \`${base}\``,
    "",
    "## Configured full check",
    "",
    `commands.test: ${JSON.stringify(testCommand)}`,
    "",
    "## The change under review",
    "",
    `The PR's whole contribution is \`git diff ${base}...${checkout.head}\` in the checkout.`,
    "",
  ].join("\n");
}

export { taskText };
