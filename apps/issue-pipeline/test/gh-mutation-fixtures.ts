// Explicit local fake-GitHub effects for the strict authority fixture families.
// Callers name the actual issues, saved comment identities and allowed labels.

import type { GhReply } from "./fake-gh.ts";

function collaboratorReply(repo: string, login: string): GhReply {
  return {
    when: `api repos/${repo}/collaborators/${login}`,
    stdout: "",
    keep: true,
  };
}

function commentWriteReplies(
  repo: string,
  issue: number,
  ids: readonly number[],
): GhReply[] {
  return [
    {
      when: `api -X POST repos/${repo}/issues/${issue}/comments -f`,
      stdout: "",
      keep: true,
    },
    ...ids.map((id) => ({
      when: `api -X PATCH repos/${repo}/issues/comments/${id} -f`,
      stdout: "",
      keep: true,
    })),
  ];
}

function labelReplies(
  repo: string,
  issue: number,
  add: readonly string[],
  remove: readonly string[],
): GhReply[] {
  const endpoint = `repos/${repo}/issues/${issue}/labels`;
  const replies = [
    {
      when: `api ${endpoint}`,
      stdout: "[]",
      keep: true,
    },
    ...remove.map((name) => ({
      when: `api -X DELETE ${endpoint}/${encodeURIComponent(name)} --silent`,
      stdout: "",
      keep: true,
    })),
  ];
  if (add.length > 0) {
    replies.push({
      when: `api -X POST ${endpoint} --silent ${add.map((name) => `-f labels[]=${name}`).join(" ")}`,
      stdout: "",
      keep: true,
    });
  }
  return replies;
}

function draftMutationReplies(issue: number, pr: number): GhReply[] {
  return [
    ...commentWriteReplies("o/r", issue, [issue]),
    ...labelReplies("o/r", pr, ["agent:working"], []),
    { when: `pr edit ${pr} -R o/r `, stdout: "", keep: true },
  ];
}

function claimMutationReplies(
  issue: number,
  stateId: number,
  pr: number | null,
  stops: readonly string[] = [],
): GhReply[] {
  const replies = [
    collaboratorReply("o/r", "alice"),
    ...commentWriteReplies("o/r", issue, [stateId]),
    ...labelReplies(
      "o/r",
      issue,
      ["agent:working"],
      ["agent:needs-info", ...stops],
    ),
  ];
  if (pr !== null) {
    replies.push(...labelReplies("o/r", pr, ["agent:working"], []));
  }
  return replies;
}

function stopMutationReplies(
  issue: number,
  {
    stateId,
    pr,
    code,
    claims = [],
  }: {
    stateId: number;
    pr: number | null;
    code: string;
    claims?: readonly number[];
  },
): GhReply[] {
  const replies = commentWriteReplies("o/r", issue, [stateId, ...claims]);
  const targets = [issue];
  if (pr !== null) {
    targets.push(pr);
    replies.push(...commentWriteReplies("o/r", pr, []));
  }
  for (const target of targets) {
    replies.push(
      ...labelReplies(
        "o/r",
        target,
        [`agent:stopped-${code}`],
        ["agent:working"],
      ),
    );
  }
  return replies;
}

export {
  claimMutationReplies,
  collaboratorReply,
  commentWriteReplies,
  draftMutationReplies,
  labelReplies,
  stopMutationReplies,
};
