// The spec writer's draft PR text (the wiki's Pipeline-Roles-Spec-Writer,
// "Branch and PR"): the body that closes the issue, carries the spec's
// Behaviour section and links to the issue, where the `## Spec` comment is.
// The title is start-pr's own. Pure.

import { specSection } from "../../spec-sections.ts";

// The body of issue `n`'s PR in `repo` ("owner/name") for `spec`.
function prBodyOf(n: number, repo: string, spec: string): string {
  const behaviour = specSection(spec, "Behaviour").join("\n").trim();
  const link = `The full spec is the \`## Spec\` comment on [#${n}](https://github.com/${repo}/issues/${n}).`;
  return [`Closes #${n}`, behaviour, link]
    .filter((part) => part !== "")
    .join("\n\n");
}

export { prBodyOf };
