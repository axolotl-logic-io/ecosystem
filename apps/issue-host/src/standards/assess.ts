// A standards assessment of one repository at one commit (#129): its
// disposition, inventory, each criterion's evidence and status, the verdict
// they add up to, and the changes and owner actions that would close the
// gaps. Install, tests and the advisory scan run in a credential-free
// sandbox (execute.ts). It writes nothing to GitHub or the origin; the caller
// decides where its results and the commands' logs go.

import { createHash } from "node:crypto";
import process from "node:process";
import type { Config } from "../config.ts";
import { GIT_ENV } from "../git-remote.ts";
import { run } from "../process.ts";
import type { CiTarget } from "./ci.ts";
import { ciOf, nodeTarget, poetryTarget } from "./ci.ts";
import { dispositionOf } from "./disposition.ts";
import { enforcementOf } from "./enforcement.ts";
import type { Execution, Log, Options } from "./execute.ts";
import { executeNode, nothingRun } from "./execute.ts";
import { executePoetry } from "./execute-poetry.ts";
import { nodeCriteria, nodeProjectOf } from "./node-npm.ts";
import { poetryCriteria, poetryProjectOf } from "./python-poetry.ts";
import type { Assessment, Component, Criterion, Workflow } from "./schema.ts";
import { ASSESSMENT, POLICY_VERSION } from "./schema.ts";
import type { Source } from "./source.ts";
import { openSource } from "./source.ts";

// The change each failed or unverified criterion asks of a Node/npm upgrade.
const NODE_CHANGES: Readonly<Record<string, string>> = {
  "environment.manifest":
    "Repair the root package.json so it parses as a package manifest.",
  "environment.toolchain": "Declare the supported Node range in engines.node.",
  "environment.lockfile":
    "Commit the package-lock.json a clean npm install produces.",
  "environment.install":
    "Run npm ci from a clean checkout and report its exit code.",
  "vulnerabilities.scan":
    "Run npm audit over the full resolved graph, dev dependencies included; fix findings with the smallest compatible upgrade, and report the date and remaining advisories.",
  "behavior.tests":
    "Add tests with real assertions for the documented behavior, behind a test script that fails when they fail.",
  "behavior.tests-run":
    "Run the tests on the candidate and report their exit code; show that a deliberate mismatch fails them.",
  "ci.triggers":
    "Add a GitHub Actions workflow that runs on pull_request and on push to the default branch.",
  "ci.runs-tests": "Make CI run npm ci and npm test.",
  "ci.failure-propagation":
    "Remove continue-on-error, || true and --if-present so a failing check fails the run.",
  "ci.advisory-refresh":
    "Refresh advisories on a schedule, with a scheduled npm audit job or Dependabot.",
  "ci.workspaces":
    "Run every workspace's tests in CI, for example with npm test --workspaces.",
  "ci.workflow-syntax": "Repair the workflow files that don't parse.",
};

// The change each failed or unverified criterion asks of a Python/Poetry
// upgrade.
const POETRY_CHANGES: Readonly<Record<string, string>> = {
  "environment.manifest":
    "Repair pyproject.toml so it parses and declares the Poetry project.",
  "environment.toolchain":
    "Declare the supported Python range in tool.poetry.dependencies.python.",
  "environment.lockfile": "Commit the poetry.lock that poetry lock produces.",
  "environment.install":
    "Run poetry check --lock and poetry install from a clean checkout, and report their exit codes.",
  "vulnerabilities.scan":
    "Scan the full locked environment, dev groups included, for example with pip-audit over poetry export --with dev; fix findings with the smallest compatible upgrade, and report the date and remaining advisories.",
  "behavior.tests":
    "Replace the version placeholder with tests that assert the documented behavior, run by pytest so a failing assertion fails the run.",
  "behavior.tests-run":
    "Run poetry run pytest on the candidate and report its exit code; show that a deliberate mismatch fails it.",
  "ci.triggers":
    "Add a GitHub Actions workflow that runs on pull_request and on push to the default branch.",
  "ci.runs-tests":
    "Make CI install the locked environment with Poetry and run poetry run pytest.",
  "ci.failure-propagation":
    "Remove continue-on-error and || true so a failing check fails the run.",
  "ci.advisory-refresh":
    "Refresh advisories on a schedule, with a scheduled pip-audit job or Dependabot for the pip ecosystem.",
  "ci.workspaces": "Assess and test each nested Python project.",
  "ci.workflow-syntax": "Repair the workflow files that don't parse.",
};

const CHANGES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "node-npm": NODE_CHANGES,
  "python-poetry": POETRY_CHANGES,
};

function versionOf(command: string, args: readonly string[]): string {
  return run(command, args, { env: GIT_ENV, allowFail: true }).stdout.trim();
}

function verdictOf(
  kind: string,
  criteria: readonly Criterion[],
): Assessment["verdict"] {
  if (kind === "archived") {
    return "no-action";
  }
  if (kind === "scaffold") {
    return "archive-candidate";
  }
  if (kind === "unsupported") {
    return "blocked";
  }
  if (criteria.some((criterion) => criterion.status === "failed")) {
    return "not-acceptable";
  }
  if (criteria.some((criterion) => criterion.status === "unverified")) {
    return "unverified";
  }
  return "acceptable";
}

function ownerActionsOf(
  kind: string,
  criteria: readonly Criterion[],
  branch: string,
): string[] {
  if (kind === "scaffold") {
    return [
      "Archive candidate: archive only with explicit operator authority; never delete the repository or its history.",
    ];
  }
  if (kind === "unsupported") {
    return [
      "Decide how to verify this toolchain; the upgrade stays blocked until a supported check exists.",
    ];
  }
  const enforcement = criteria.find(
    (criterion) => criterion.id === "enforcement.required-checks",
  );
  if (enforcement?.status === "failed") {
    return [
      `Require the CI check on ${branch}. This needs separate administrative authority; the upgrade's pull request can't change repository settings.`,
    ];
  }
  if (enforcement?.status === "unverified") {
    return [
      `Show the pipeline's read account ${branch}'s branch protection, or confirm its required checks.`,
    ];
  }
  return [];
}

interface Found {
  execution: Execution;
  components: Component[];
  workflows: Workflow[];
  requiredChecks: string[] | null;
  criteria: Criterion[];
}

interface Checked {
  components: Component[];
  criteria: Criterion[];
  target: CiTarget;
}

// When the assessment runs, and how its sandboxed checks fetch (a null
// registry assesses statically).
interface AssessOptions extends Options {
  now: Date;
}

// The ecosystem's own components, criteria (executed ones included) and CI
// target, or null when the disposition gets no criteria.
function checkedOf(
  source: Source,
  kind: string,
  options: AssessOptions,
): (Checked & { execution: Execution }) | null {
  if (kind === "node-npm") {
    const project = nodeProjectOf(source);
    const execution = executeNode(source, options);
    return {
      execution,
      components: project.components,
      criteria: nodeCriteria(source, project, execution.criteria),
      target: nodeTarget(project),
    };
  }
  if (kind === "python-poetry") {
    const project = poetryProjectOf(source);
    const execution = executePoetry(source, options);
    return {
      execution,
      components: project.components,
      criteria: poetryCriteria(source, project, execution.criteria),
      target: poetryTarget(project),
    };
  }
  return null;
}

function criteriaOf(
  cfg: Config,
  source: Source,
  kind: string,
  options: AssessOptions,
): Found {
  const checked = checkedOf(source, kind, options);
  if (checked === null) {
    return {
      execution: nothingRun(null, "no criteria apply"),
      components: [],
      workflows: [],
      requiredChecks: null,
      criteria: [],
    };
  }
  const ci = ciOf(source, checked.target);
  const enforcement = enforcementOf(cfg, source.defaultBranch);
  return {
    execution: checked.execution,
    components: checked.components,
    workflows: ci.workflows,
    requiredChecks: enforcement.requiredChecks,
    criteria: [...checked.criteria, ...ci.criteria, enforcement.criterion],
  };
}

// Assesses `input` (OWNER/REPO or its GitHub URL) at `ref`, or the default
// branch when null, with the logs of the commands it ran. Throws a Refusal
// for the wrong repository or ref.
function assess(
  cfg: Config,
  input: string,
  ref: string | null,
  options: AssessOptions,
): { assessment: Assessment; logs: Log[] } {
  const source = openSource(cfg, input, ref);
  try {
    const disposition = dispositionOf(source);
    const found = criteriaOf(cfg, source, disposition.kind, options);
    const gaps = found.criteria.filter(
      (criterion) =>
        criterion.status === "failed" || criterion.status === "unverified",
    );
    const assessment = ASSESSMENT.parse({
      version: 2,
      policy: POLICY_VERSION,
      repo: source.repo,
      requestedRef: ref,
      sourceRef: source.sourceRef,
      source: source.commit,
      assessedAt: options.now.toISOString(),
      toolchain: {
        node: process.version,
        git: versionOf("git", ["--version"]),
      },
      disposition,
      inventory: {
        files: source.files.length,
        components: found.components,
        workflows: found.workflows,
        requiredChecks: found.requiredChecks,
      },
      criteria: found.criteria,
      verdict: verdictOf(disposition.kind, found.criteria),
      proposed: gaps.flatMap(({ id }) =>
        [CHANGES[disposition.kind]?.[id] ?? []]
          .flat()
          .map((change) => ({ criterion: id, change })),
      ),
      ownerActions: ownerActionsOf(
        disposition.kind,
        found.criteria,
        source.defaultBranch,
      ),
      sandbox: found.execution.sandbox,
      commands: found.execution.commands,
    });
    return { assessment, logs: found.execution.logs };
  } finally {
    source.dispose();
  }
}

// What a plan binds: the assessment without its time, requested ref and the
// commands' durations, so a rerun on the same commit, policy, toolchain and
// advisory data gives the same digest.
function digestOf(assessment: Assessment): string {
  const { assessedAt: _time, requestedRef: _ref, ...rest } = assessment;
  const bound = {
    ...rest,
    commands: rest.commands.map(({ durationMs: _ms, ...command }) => command),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(bound)).digest("hex")}`;
}

export type { AssessOptions };
export { assess, digestOf };
