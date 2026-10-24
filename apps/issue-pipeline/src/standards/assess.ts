// A standards assessment of one repository at one commit (#129): its
// disposition, inventory, each criterion's evidence and status, the verdict
// they add up to, and the changes and owner actions that would close the
// gaps. It writes nothing anywhere; the caller decides where its results go.

import { createHash } from "node:crypto";
import process from "node:process";
import type { Config } from "../config.ts";
import { GIT_ENV } from "../git-remote.ts";
import { run } from "../process.ts";
import { ciOf } from "./ci.ts";
import { dispositionOf } from "./disposition.ts";
import { enforcementOf } from "./enforcement.ts";
import { nodeCriteria, nodeProjectOf } from "./node-npm.ts";
import type { Assessment, Component, Criterion, Workflow } from "./schema.ts";
import { ASSESSMENT, POLICY_VERSION } from "./schema.ts";
import type { Source } from "./source.ts";
import { openSource } from "./source.ts";

// The change each failed or unverified criterion asks of the upgrade.
const CHANGES: Readonly<Record<string, string>> = {
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
  components: Component[];
  workflows: Workflow[];
  requiredChecks: string[] | null;
  criteria: Criterion[];
}

function criteriaOf(cfg: Config, source: Source, kind: string): Found {
  if (kind !== "node-npm") {
    return {
      components: [],
      workflows: [],
      requiredChecks: null,
      criteria: [],
    };
  }
  const project = nodeProjectOf(source);
  const ci = ciOf(source, project);
  const enforcement = enforcementOf(cfg, source.defaultBranch);
  return {
    components: project.components,
    workflows: ci.workflows,
    requiredChecks: enforcement.requiredChecks,
    criteria: [
      ...nodeCriteria(source, project),
      ...ci.criteria,
      enforcement.criterion,
    ],
  };
}

// Assesses `input` (OWNER/REPO or its GitHub URL) at `ref`, or the default
// branch when null. Throws a Refusal for the wrong repository or ref.
function assess(
  cfg: Config,
  input: string,
  ref: string | null,
  now: Date,
): Assessment {
  const source = openSource(cfg, input, ref);
  try {
    const disposition = dispositionOf(source);
    const found = criteriaOf(cfg, source, disposition.kind);
    const gaps = found.criteria.filter(
      (criterion) =>
        criterion.status === "failed" || criterion.status === "unverified",
    );
    return ASSESSMENT.parse({
      version: 1,
      policy: POLICY_VERSION,
      repo: source.repo,
      requestedRef: ref,
      sourceRef: source.sourceRef,
      source: source.commit,
      assessedAt: now.toISOString(),
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
        [CHANGES[id] ?? []].flat().map((change) => ({ criterion: id, change })),
      ),
      ownerActions: ownerActionsOf(
        disposition.kind,
        found.criteria,
        source.defaultBranch,
      ),
      commands: [],
    });
  } finally {
    source.dispose();
  }
}

// What a plan binds: the assessment without its time and requested ref, so
// a rerun on the same commit, policy and toolchain gives the same digest.
function digestOf(assessment: Assessment): string {
  const { assessedAt: _time, requestedRef: _ref, ...bound } = assessment;
  return `sha256:${createHash("sha256").update(JSON.stringify(bound)).digest("hex")}`;
}

export { assess, digestOf };
