// @ts-check
// Explicit local fake-GitHub effects for the strict authority fixture families.
// Callers name the actual issues, saved comment identities and allowed labels.

/** @import { GhReply } from "./fake-gh.mjs" */

/** @param {string} repo @param {string} login @returns {GhReply} */
function collaboratorReply(repo, login) {
  return {
    when: `api repos/${repo}/collaborators/${login}`,
    stdout: "",
    keep: true,
  };
}

/** @param {string} repo @param {number} issue @param {readonly number[]} ids @returns {GhReply[]} */
function commentWriteReplies(repo, issue, ids) {
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

/** @param {string} repo @param {number} issue @param {readonly string[]} add @param {readonly string[]} remove @returns {GhReply[]} */
function labelReplies(repo, issue, add, remove) {
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

/** @param {number} issue @param {number} pr @returns {GhReply[]} */
function draftMutationReplies(issue, pr) {
  return [
    ...commentWriteReplies("o/r", issue, [issue]),
    ...labelReplies("o/r", pr, ["agent:working"], []),
    { when: `pr edit ${pr} -R o/r `, stdout: "", keep: true },
  ];
}

/** @param {number} issue @param {number} stateId @param {number | null} pr @param {readonly string[]} [stops] @returns {GhReply[]} */
function claimMutationReplies(issue, stateId, pr, stops = []) {
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

/** @param {number} issue @param {{stateId: number, pr: number | null, code: string, claims?: readonly number[]}} stop @returns {GhReply[]} */
function stopMutationReplies(issue, { stateId, pr, code, claims = [] }) {
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
