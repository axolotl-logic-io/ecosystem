// Canonical bytes of already authenticated human requirements. Authentication
// belongs to the reader; both readers hash exactly these bytes.
import type { IssueComment } from "./comments.ts";

function trustedInputBytes(
  issue: { title: string; body?: string | null | undefined },
  trusted: readonly IssueComment[],
): string {
  return [
    JSON.stringify(["issue", issue.title, issue.body ?? ""]),
    ...trusted
      .toSorted((a, b) => a.id - b.id)
      .map((item) => JSON.stringify(["comment", item.id, item.body ?? ""])),
  ].join("");
}

export { trustedInputBytes };
