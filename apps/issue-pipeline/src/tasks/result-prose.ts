// The words a person reads on a task result comment. Each result comment
// holds its hidden machine record first and this prose after it
// (records.ts). The prose says what happened, what was checked or kept, and
// what comes next, in plain words to the issue's readers. It is written
// from the record alone, so it never says more than the record proves, and
// no reader takes authority from it.

import type { TaskId } from "../domain.ts";
import {
  INTERRUPTED_EVIDENCE,
  LAND_EVIDENCE,
  VERIFY_EVIDENCE,
} from "../domain.ts";
import type { Result } from "./records.ts";

const SHORT_SHA = 7;
const ENDS_SENTENCE = /[.!?]$/u;

const NAMES: Readonly<Record<TaskId, string>> = {
  implement: "Implement",
  verify: "Verify",
  fix: "Fix",
  land: "Land",
  "refactor-safely": "Safe Refactor",
};

// The tasks whose unsettled runs a later action reconciles by reading.
const RECONCILES: ReadonlySet<TaskId> = new Set([
  "implement",
  "verify",
  "fix",
  "land",
]);

// The tasks that push code to the issue's branch.
const WRITES_CODE: ReadonlySet<TaskId> = new Set(["implement", "fix"]);

function short(sha: string): string {
  return `\`${sha.slice(0, SHORT_SHA)}\``;
}

// `text` as one sentence: a capital first letter and a closing stop.
function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  if (ENDS_SENTENCE.test(capital)) {
    return capital;
  }
  return `${capital}.`;
}

// The produced head, as a sentence to follow another, or nothing.
function headOf(result: Result): string {
  const produced = result.receipt.produced?.code;
  if (produced === undefined) {
    return "";
  }
  return ` The branch head is ${short(produced)}.`;
}

function passedLine(result: Result): string {
  switch (result.binding.task) {
    case "implement":
      return `I implemented this issue and opened a pull request for it.${headOf(result)} To review it, add the \`start:verify\` label.`;
    case "verify":
      return "I reviewed the pull request and approved it. To merge it once its checks pass, add the `start:land` label.";
    case "fix":
      return `I updated the pull request to answer the review.${headOf(result)} To review the new head, add the \`start:verify\` label.`;
    case "land": {
      const land = LAND_EVIDENCE.safeParse(result.receipt.evidence);
      if (land.success && land.data.outcome === "merged") {
        return `I merged pull request #${String(land.data.pr)} with merge commit ${short(land.data.mergeCommit)} and closed this issue.`;
      }
      return "I merged the pull request and closed this issue.";
    }
    default:
      return "I finished the safe refactor.";
  }
}

function refusedLine(result: Result): string {
  switch (result.binding.task) {
    case "verify": {
      const verify = VERIFY_EVIDENCE.safeParse(result.receipt.evidence);
      if (verify.success) {
        return `I reviewed pull request #${String(verify.data.review.pr)} and asked for changes. To answer the review, add the \`start:fix\` label.`;
      }
      return "I reviewed the pull request and asked for changes. To answer the review, add the `start:fix` label.";
    }
    case "land":
      return "I didn't merge the pull request because it conflicts with its base branch. I marked it as a draft. To resolve the conflict, add the `start:fix` label.";
    default:
      return `${NAMES[result.binding.task]} stopped without making its change.`;
  }
}

// What a failed result says about where the work is and what happens next.
function failedLines(result: Result): string[] {
  const name = NAMES[result.binding.task];
  const interrupted = INTERRUPTED_EVIDENCE.safeParse(result.receipt.evidence);
  if (interrupted.success) {
    const { branch, head, continues } = interrupted.data.interrupted;
    let kept = `It hadn't pushed any commits to \`${branch}\`.`;
    if (head !== null) {
      kept = `Its pushed work is on \`${branch}\` at ${short(head)}.`;
    }
    let next =
      "I won't continue it on my own, because the issue's requirements changed or it has used all its attempts. A person can start Implement again when the issue is ready.";
    if (continues) {
      next =
        "To continue from that branch, add the `start:implement` label again. I'll check first that the requirements are current and the issue isn't stopped.";
    }
    return [
      `An earlier ${name} run for this issue stopped before it finished.`,
      `${kept} ${next}`,
    ];
  }
  let next = "A person needs to look at this before it runs again.";
  if (WRITES_CODE.has(result.binding.task)) {
    next = `I never delete or overwrite pushed commits, so anything I pushed is still on GitHub. ${next}`;
  }
  return [
    `I couldn't finish ${name} for this issue.`,
    sentence(result.receipt.summary),
    next,
  ];
}

function unknownLines(result: Result): string[] {
  const name = NAMES[result.binding.task];
  let next =
    "A person needs to check what happened on GitHub before it runs again.";
  if (RECONCILES.has(result.binding.task)) {
    next =
      "I'll check GitHub to find out before doing anything else, and I won't repeat a change that may already have happened.";
  }
  return [
    `I couldn't confirm how ${name} ended for this issue.`,
    sentence(result.receipt.summary),
    next,
  ];
}

// The prose of `result`'s comment, one paragraph per idea.
function resultProse(result: Result): string {
  let paragraphs: string[];
  switch (result.verdict) {
    case "passed":
      paragraphs = [passedLine(result)];
      if (WRITES_CODE.has(result.binding.task)) {
        paragraphs.push(`What changed: ${result.receipt.summary.trim()}`);
      }
      break;
    case "refused":
      paragraphs = [refusedLine(result), sentence(result.receipt.summary)];
      break;
    case "failed":
      paragraphs = failedLines(result);
      break;
    default:
      paragraphs = unknownLines(result);
  }
  return paragraphs.join("\n\n");
}

export { resultProse };
