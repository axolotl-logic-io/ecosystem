// The stops: each is a failed control, a limit or check the issue didn't
// pass. Each control has its own label, agent:stopped-<code>, and every stop
// posts a comment naming the control, the reason and how to resume. The wiki
// page Agent-Labels in the configured repository documents every label; keep
// it in step with this table. A stop's reason is free text; the first
// matching control below names it. A label of a removed control, such as
// agent:stopped-budget, still reads as a stop (isStopLabel).

interface GitHubLabel {
  name: string;
  color: string;
  description: string;
}

interface Stop {
  code: string;
  // The stop label's description.
  short: string;
  // Matches the workflow's free-text reasons for this stop.
  test: RegExp;
  control: string;
  explain: string;
  label: GitHubLabel;
}

const STOP_PREFIX = "agent:stopped-";
const STOP_COLOR = "d93f0b";

// A config setting's name, in parentheses, for an explanation.
function settingRef(setting: string): string {
  return `(\`${setting}\`)`;
}

// An explanation that ends by naming the config setting that sets its limit.
function limitText(text: string, setting: string): string {
  return `${text} ${settingRef(setting)}.`;
}

const ROWS: readonly Omit<Stop, "label">[] = [
  {
    code: "user-harm",
    short:
      "Stopped: security review found harm to users. See the stop comment.",
    test: /security (?:check|review) \(user-harm\)/iu,
    control: "security: harm to users",
    explain:
      "The security review found the change would harm the app's users, for example by exposing, leaking or destroying their data.",
  },
  {
    code: "rights",
    short:
      "Stopped: security review found a violation of users' rights. See the stop comment.",
    test: /security (?:check|review) \(rights\)/iu,
    control: "security: users' rights",
    explain:
      "The security review found the change would violate users' rights, for example privacy, consent or access to their own data.",
  },
  {
    code: "financial-harm",
    short:
      "Stopped: security review found financial harm. See the stop comment.",
    test: /security (?:check|review) \(financial-harm\)/iu,
    control: "security: financial harm",
    explain:
      "The security review found the change would cause financial harm to users or the operator.",
  },
  {
    code: "abuse-risk",
    short:
      "Stopped: security review found a risk of abuse. See the stop comment.",
    test: /security (?:check|review) \(abuse-risk\)/iu,
    control: "security: abuse risk",
    explain:
      "The security review found the change would introduce a risk of abuse, for example missing auth or rate limits, privilege escalation or injection.",
  },
  {
    code: "review-rounds",
    short:
      "Stopped: blocking findings remain after the fix rounds. See the stop comment.",
    test: /blocking findings remain/iu,
    control: "review fix rounds",
    explain: limitText(
      "Blocking review findings were still open after the allowed fix rounds",
      "maxFixRounds",
    ),
  },
  {
    code: "check-fixes",
    short:
      "Stopped: checks still fail after the check-fix attempts. See the stop comment.",
    test: /checks still fail|checks did not pass within/iu,
    control: "check fix attempts",
    explain: limitText(
      "Checks still failed after the allowed check-fix attempts",
      "maxCiFixes",
    ),
  },
  {
    code: "no-ci",
    short:
      "Stopped: CI is required and the PR has no required checks. See the stop comment.",
    test: /no required CI checks/iu,
    control: "required CI",
    explain:
      "The config requires CI checks (`requireCi`), and the PR has none.",
  },
  {
    code: "not-doable",
    short:
      "Stopped: the implementer can't do the issue as written. See the stop comment.",
    test: /could not do the issue as written|the implementation changed nothing/iu,
    control: "implementer",
    explain:
      "The implementer found the issue can't be done as written, or its work changed nothing: no files on the branch and no wiki commits.",
  },
  {
    code: "branch-changed",
    short:
      "Stopped: the PR branch changed outside the pipeline. See the stop comment.",
    test: /branch changed/iu,
    control: "branch integrity",
    explain:
      "The PR branch changed outside the pipeline, so it stopped rather than overwrite it.",
  },
  {
    code: "wiki-check",
    short:
      "Stopped: the wiki changes failed the wiki check. See the stop comment.",
    test: /wiki check/iu,
    control: "wiki check",
    explain:
      "Before the code merges, the issue's wiki changes, rebased onto the wiki's latest version, must pass the wiki check: every link in a changed page names a page on the wiki, and every new page is linked from _Sidebar or another page.",
  },
  {
    code: "conflict",
    short:
      "Stopped: rebase conflicts could not be resolved. See the stop comment.",
    test: /conflict/iu,
    control: "conflict resolution",
    explain: `Rebasing onto the base branch conflicted, and the resolver's attempts ${settingRef("maxConflictFixes")} ran out, or its resolution was rejected.`,
  },
  {
    code: "sync-limit",
    short:
      "Stopped: rebased too many times without merging. See the stop comment.",
    test: /kept moving/iu,
    control: "rebase attempts",
    explain:
      "The base branch kept moving, and the branch was rebased the allowed number of times (`maxSyncs`) without merging.",
  },
  {
    code: "push-rejected",
    short: "Stopped: GitHub rejected a push. See the stop comment.",
    test: /could not push|push.*reject/iu,
    control: "push",
    explain: "GitHub rejected a push of the PR branch.",
  },
  {
    code: "merge-refused",
    short: "Stopped: GitHub refused the merge. See the stop comment.",
    test: /refused the merge/iu,
    control: "merge",
    explain: "GitHub refused the merge.",
  },
  {
    code: "job",
    short:
      "Stopped: the stage job kept dying and was restarted too often. See the stop comment.",
    test: /stage job kept dying/iu,
    control: "stage job restarts",
    explain: limitText(
      "The issue's stage job died with no outcome after the orchestrator had already restarted it the most times it may",
      "maxResumes",
    ),
  },
  {
    code: "error",
    short:
      "Stopped: a pipeline step or agent session failed. See the stop comment.",
    test: /./u,
    control: "step failure",
    explain:
      "A pipeline step or agent session failed, or the issue's claim failed with the same error `claimFailureStreak` times in a row.",
  },
];

const STOPS: readonly Stop[] = ROWS.map(
  (row): Stop => ({
    ...row,
    label: {
      name: STOP_PREFIX + row.code,
      color: STOP_COLOR,
      description: row.short,
    },
  }),
);

function isStopLabel(name: string): boolean {
  return name.startsWith(STOP_PREFIX);
}

// The stop a free-text reason names; `error` catches every other reason.
function stopFor(reason: string | null | undefined): Stop | undefined {
  const text = reason ?? "";
  return STOPS.find((stop) => stop.test.test(text));
}

export type { GitHubLabel, Stop };
export { isStopLabel, STOP_PREFIX, STOPS, stopFor };
