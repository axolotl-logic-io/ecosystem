// The CI part of a standards assessment, read from the source's GitHub
// Actions workflows: whether checks run for pull requests and the default
// branch, run the tests, let failures fail, refresh advisories and cover
// every workspace or nested project. What counts as a test command depends on
// the ecosystem, so each one supplies a CiTarget. Workflow YAML is evidence
// of what would run, not of enforcement; enforcement.ts reads that from
// GitHub (#129).

import { parse } from "yaml";
import { z } from "zod";
import type { NodeProject } from "./node-npm.ts";
import type { PoetryProject } from "./python-poetry.ts";
import type { Criterion, Workflow } from "./schema.ts";
import type { Source } from "./source.ts";

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/u;
const DEPENDABOT = /^\.github\/dependabot\.ya?ml$/u;
const NPM_TEST =
  /\bnpm(?:\s+-\S+)*\s+(?:test|t|run(?:-script)?\s+(?:test|check|ci))\b/u;
// pytest, directly, through `poetry run` or through Python's module runner.
const PYTHON_TEST =
  /(?:^|[\s;&|(])(?:pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest))\b/u;
const WORKSPACES_FLAG = /(?:--workspaces|\s-ws)\b/u;
const SWALLOWED = /\|\|\s*(?:true|exit\s+0|:)|--if-present/u;

const STEP = z.looseObject({
  run: z.string().optional(),
  "continue-on-error": z.unknown().optional(),
});
const JOB = z.looseObject({
  steps: z.array(STEP).optional(),
  "continue-on-error": z.unknown().optional(),
});
const DOCUMENT = z.looseObject({
  on: z.unknown().optional(),
  jobs: z.record(z.string(), JOB).optional(),
});
type Job = z.infer<typeof JOB>;

// What CI must run for one ecosystem: steps matching `tests`, named
// `runner` in evidence, and the check that every component runs.
interface CiTarget {
  tests: RegExp;
  runner: string;
  workspaces: (runs: readonly string[]) => Criterion;
}

interface ParsedWorkflow {
  workflow: Workflow;
  // Trigger name to its branch filter; null when it has none.
  branches: Map<string, string[] | null>;
  jobs: Job[];
}

const BRANCHES = z
  .looseObject({ branches: z.array(z.string()).optional() })
  .nullable();

function triggersOf(on: unknown): Map<string, string[] | null> {
  if (typeof on === "string") {
    return new Map([[on, null]]);
  }
  if (Array.isArray(on)) {
    return new Map(
      on.filter((name) => typeof name === "string").map((name) => [name, null]),
    );
  }
  const triggers = new Map<string, string[] | null>();
  for (const [name, filter] of Object.entries(
    z.record(z.string(), z.unknown()).catch({}).parse(on),
  )) {
    triggers.set(name, BRANCHES.catch(null).parse(filter)?.branches ?? null);
  }
  return triggers;
}

function parsedWorkflow(source: Source, file: string): ParsedWorkflow {
  let document: z.infer<typeof DOCUMENT> | null = null;
  try {
    document = DOCUMENT.parse(parse(source.read(file) ?? ""));
  } catch {
    document = null;
  }
  if (document === null) {
    return {
      workflow: { path: file, triggers: [], parsed: false },
      branches: new Map(),
      jobs: [],
    };
  }
  const branches = triggersOf(document.on);
  return {
    workflow: {
      path: file,
      triggers: [...branches.keys()].sort(),
      parsed: true,
    },
    branches,
    jobs: Object.values(document.jobs ?? {}),
  };
}

function runsOf(jobs: readonly Job[]): string[] {
  return jobs.flatMap((job) =>
    (job.steps ?? []).flatMap((step) => step.run ?? []),
  );
}

function triggerCriterion(
  workflows: readonly ParsedWorkflow[],
  defaultBranch: string,
): Criterion {
  const pulls = workflows.some(({ branches }) => branches.has("pull_request"));
  const pushes = workflows.some(({ branches }) => {
    if (!branches.has("push")) {
      return false;
    }
    const filter = branches.get("push") ?? null;
    return filter === null || filter.includes(defaultBranch);
  });
  const missing: string[] = [];
  if (!pulls) {
    missing.push("pull_request");
  }
  if (!pushes) {
    missing.push(`push to ${defaultBranch}`);
  }
  if (missing.length === 0) {
    return {
      id: "ci.triggers",
      status: "passed",
      evidence: `workflows run on pull_request and push to ${defaultBranch}`,
    };
  }
  return {
    id: "ci.triggers",
    status: "failed",
    evidence: `no workflow runs on ${missing.join(" or ")}`,
  };
}

function testRunCriterion(
  runs: readonly string[],
  target: CiTarget,
): Criterion {
  const tests = runs.filter((line) => target.tests.test(line));
  if (tests.length === 0) {
    return {
      id: "ci.runs-tests",
      status: "failed",
      evidence: `no workflow step runs the ${target.runner} tests`,
    };
  }
  return {
    id: "ci.runs-tests",
    status: "passed",
    evidence: `steps run ${JSON.stringify(tests[0]?.trim())}`,
  };
}

function propagationCriterion(
  workflows: readonly ParsedWorkflow[],
  runs: readonly string[],
  target: CiTarget,
): Criterion {
  const permissive = workflows.flatMap(({ workflow, jobs }) =>
    jobs
      .flatMap((job) => [job, ...(job.steps ?? [])])
      .filter(
        (part) =>
          part["continue-on-error"] !== undefined &&
          part["continue-on-error"] !== false,
      )
      .map(() => `${workflow.path} sets continue-on-error`),
  );
  const swallowed = runs.filter(
    (line) => target.tests.test(line) && SWALLOWED.test(line),
  );
  const found = [
    ...permissive,
    ...swallowed.map(
      (line) => `${JSON.stringify(line.trim())} hides a failure`,
    ),
  ];
  if (found.length > 0) {
    return {
      id: "ci.failure-propagation",
      status: "failed",
      evidence: found.join("; "),
    };
  }
  return {
    id: "ci.failure-propagation",
    status: "passed",
    evidence:
      "no continue-on-error, || true or --if-present hides a failing step",
  };
}

function refreshCriterion(
  source: Source,
  workflows: readonly ParsedWorkflow[],
): Criterion {
  if (source.files.some((file) => DEPENDABOT.test(file))) {
    return {
      id: "ci.advisory-refresh",
      status: "passed",
      evidence: "Dependabot configuration refreshes advisories",
    };
  }
  if (workflows.some(({ branches }) => branches.has("schedule"))) {
    return {
      id: "ci.advisory-refresh",
      status: "passed",
      evidence: "a scheduled workflow runs without dependency changes",
    };
  }
  return {
    id: "ci.advisory-refresh",
    status: "failed",
    evidence: "nothing refreshes advisory evidence without a dependency change",
  };
}

function workspaceCriterion(
  project: NodeProject,
  runs: readonly string[],
): Criterion {
  const id = "ci.workspaces";
  if (project.components.length <= 1 && project.unexpanded.length === 0) {
    return { id, status: "not-applicable", evidence: "one component" };
  }
  if (project.unexpanded.length > 0) {
    return {
      id,
      status: "unverified",
      evidence: `workspace patterns not expanded: ${project.unexpanded.join(", ")}`,
    };
  }
  const { test: rootTest = "" } = project.manifest?.scripts ?? {};
  if (
    WORKSPACES_FLAG.test(rootTest) ||
    runs.some((line) => NPM_TEST.test(line) && WORKSPACES_FLAG.test(line))
  ) {
    return { id, status: "passed", evidence: "tests run with --workspaces" };
  }
  return {
    id,
    status: "failed",
    evidence: `${project.components.length - 1} workspace(s), but neither CI nor the root test script runs --workspaces`,
  };
}

function nodeTarget(project: NodeProject): CiTarget {
  return {
    tests: NPM_TEST,
    runner: "npm",
    workspaces: (runs: readonly string[]): Criterion =>
      workspaceCriterion(project, runs),
  };
}

// A Poetry project's nested pyproject.toml files aren't expanded, so CI
// coverage of them stays unverified.
function poetryTarget(project: PoetryProject): CiTarget {
  return {
    tests: PYTHON_TEST,
    runner: "pytest",
    workspaces: (): Criterion => {
      const id = "ci.workspaces";
      if (project.nested.length === 0) {
        return { id, status: "not-applicable", evidence: "one Poetry project" };
      }
      return {
        id,
        status: "unverified",
        evidence: `nested Python projects not assessed: ${project.nested.join(", ")}`,
      };
    },
  };
}

// The workflows found and the CI criteria, in a fixed order.
function ciOf(
  source: Source,
  target: CiTarget,
): { workflows: Workflow[]; criteria: Criterion[] } {
  const parsed = source.files
    .filter((file) => WORKFLOW_FILE.test(file))
    .map((file) => parsedWorkflow(source, file));
  const workflows = parsed.map(({ workflow }) => workflow);
  const runs = runsOf(parsed.flatMap(({ jobs }) => jobs));
  const criteria = [
    triggerCriterion(parsed, source.defaultBranch),
    testRunCriterion(runs, target),
    propagationCriterion(parsed, runs, target),
    refreshCriterion(source, parsed),
    target.workspaces(runs),
  ];
  const unparsed = workflows.filter((workflow) => !workflow.parsed);
  if (unparsed.length > 0) {
    const evidence = `unparseable workflow(s): ${unparsed.map((workflow) => workflow.path).join(", ")}`;
    criteria.push({ id: "ci.workflow-syntax", status: "failed", evidence });
  }
  return { workflows, criteria };
}

export type { CiTarget };
export { ciOf, nodeTarget, poetryTarget };
