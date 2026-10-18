// The merge stage's session tasks: the Reviewer's resolution of a rebase
// its own integration stopped on conflicts, and the read-only security
// review of the merged result. Pure.

import { JOB_DOCS, JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { Revision } from "../../state.ts";
import { bullets, header, SHORT_SHA } from "../change-task.ts";
import { standingRules } from "../prompt-rules.ts";

// Which checkout a stopped rebase is in.
type Side = "code" | "wiki";

// What prepare-review wrote for the security review.
interface PreparedReview {
  diffPath: string;
  bundlePath: string;
  changedFiles: readonly string[];
}

interface SecurityReviewFacts {
  prepared: PreparedReview;
  // The merged result under review: GitHub's merge commit (null for a
  // change that lives only in the wiki) and the wiki head to publish.
  revision: Revision;
}

const SECURITY_LINES = [
  "`user-harm`: the change would harm the app's users, for example by exposing, leaking or destroying their data.",
  "`rights`: it would violate users' rights, such as privacy, consent or access to their own data.",
  "`financial-harm`: it would cause financial harm to users or the operator.",
  "`abuse-risk`: it would open a risk of abuse, such as missing auth or rate limits, privilege escalation or injection.",
];

// Each side's checkout in the job's folder.
const SIDE_DIRS: Readonly<Record<Side, string>> = {
  code: JOB_REPO,
  wiki: JOB_DOCS,
};

function ontoOf(ctx: RoleContext, side: Side): string {
  if (side === "code") {
    return `origin/${ctx.cfg.baseBranch}`;
  }
  return "the wiki's latest version";
}

// The task of a session that resolves a rebase stopped on conflicts.
function resolverTask(
  ctx: RoleContext,
  side: Side,
  conflict: {
    conflicts: readonly string[];
    baseSha: string;
    attempt: number;
    max: number;
    rejected: string | null;
  },
): string {
  const { [side]: dir } = SIDE_DIRS;
  const onto = ontoOf(ctx, side);
  const lines = [
    ...header(ctx, "Resolve the rebase conflicts of"),
    `The issue's change passed hardening and is being integrated for merge: the pipeline is rebasing the issue's branch in \`${dir}/\` onto ${onto} (${conflict.baseSha.slice(0, SHORT_SHA)}), and the rebase stopped on conflicts in:`,
    "",
    ...bullets(conflict.conflicts),
    "",
    `For each stopped commit, read what ${onto} changed in the conflicting files and what the stopped commit changed (\`git -C ${dir} show REBASE_HEAD\`), and write a resolution that keeps the intent of both, with no conflict markers left. Then stage only the files you resolved, with \`git -C ${dir} add -- <file>\`, and run \`GIT_EDITOR=true git -C ${dir} rebase --continue\`. Repeat until the rebase finishes.`,
    "",
    "Besides reading commands such as `git show`, those two are the only git commands you may run, and only for this rebase: replaying the stopped commits is not leave to make any other commit. Never skip, abort or reset the rebase, and never pass `--no-verify`. Make no other change here: the pipeline checks the result, and a fix session follows if its checks fail.",
    "",
    `No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what ${onto} now does and re-apply the branch's change on top of it as far as it still makes sense, and say in your summary what you chose.`,
    "",
  ];
  if (conflict.rejected !== null) {
    lines.push(
      "The pipeline rejected the last resolution of this rebase:",
      "",
      conflict.rejected,
      "",
    );
  }
  lines.push(
    `This is resolution attempt ${conflict.attempt} of ${conflict.max}. Reply \`conflict-resolved\` with a \`summary\` once the rebase has finished, or \`cannot-fix\` with a \`summary\` when you could not finish it; the pipeline checks the result either way.`,
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  );
  return lines.join("\n");
}

function resultLines(facts: SecurityReviewFacts): string[] {
  const { prepared, revision } = facts;
  const lines = [
    `The merged change is in \`${prepared.bundlePath}\` (the diff, then each changed file's text) and \`${prepared.diffPath}\` (the diff alone). It touches: ${prepared.changedFiles.join(", ") || "no files"}.`,
  ];
  if (revision.code === null) {
    lines.push("The change merged no code: it lives only in the wiki.");
  } else {
    lines.push(
      `The code merged as \`${revision.code}\`, which is checked out in \`${JOB_REPO}/\`: it is the merged result, any conflict resolution included.`,
    );
  }
  if (revision.wiki === null) {
    lines.push("The change has no wiki commits to publish.");
  } else {
    lines.push(
      `The wiki head to publish is \`${revision.wiki}\`, checked out in \`${JOB_DOCS}/\`.`,
    );
  }
  return lines;
}

// The task of the security review of the merged result.
function securityReviewTask(
  ctx: RoleContext,
  facts: SecurityReviewFacts,
): string {
  return [
    `# Security review of issue #${ctx.issue}'s merged result in ${ctx.cfg.repo}`,
    "",
    `The issue is in \`${ctx.issueFile}\`. Its change passed the Reviewer's hardening, which owns its design, correctness and tests, and the pipeline merged it into \`${ctx.cfg.baseBranch}\` after its checks passed. Its wiki change is not published yet. Judge only whether the merged result is safe.`,
    "",
    ...resultLines(facts),
    "",
    "Judge it in four security categories:",
    "",
    ...bullets(SECURITY_LINES),
    "",
    "Set `security` to the category and the reason only when you confirmed, from code or text you read, that the merged result would cause that harm: the issue then stops for a person, and its wiki is not published. Leave it null otherwise. Don't judge the design, the tests or whether the change does what the issue asks: hardening did.",
    "",
    "Reply with a `summary` of what you examined and what you found.",
    "",
    "You only read: don't edit, commit or run anything.",
    "",
    ...standingRules(ctx.cfg.baseBranch, false),
  ].join("\n");
}

export type { PreparedReview, SecurityReviewFacts, Side };
export { resolverTask, securityReviewTask };
