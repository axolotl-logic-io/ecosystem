// The executed half of a Python/Poetry standards assessment (#129), in the
// same credential-free sandbox as Node/npm's (execute.ts). Nothing is
// installed on the host: the host's Python makes a throwaway venv in the
// sandbox, and pip fills it with the hash-pinned, wheel-only poetry and
// pip-audit from the operator's index. Then tool code only, with the
// network: `poetry install --no-root` (dependencies, wheels only, into
// /work/.venv) and `pip-audit` over that environment. Only then does
// repository code run, with no network: `poetry install --only-root` and
// pytest, twice and then with a deliberately failing test added, as for npm
// (execute.ts). The criteria hold only exit codes and advisory counts.

import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import type { Execution, Options } from "./execute.ts";
import {
  COMMAND_MS,
  exited,
  inWorkspace,
  nothingRun,
  Steps,
  testFolder,
  testsRunCriterion,
  unrun,
} from "./execute.ts";
import type { SandboxRun } from "./sandbox.ts";
import { hostPython, openSandbox } from "./sandbox.ts";
import type { Criterion, SandboxRecord } from "./schema.ts";
import type { Source } from "./source.ts";

// Where things appear inside the sandbox.
const TOOLS = "/tools";
const TOOLS_FILE = "/opt/standards/python-tools.txt";
const TOOLS_PYTHON = `${TOOLS}/venv/bin/python`;
const POETRY = `${TOOLS}/venv/bin/poetry`;
const PIP_AUDIT = `${TOOLS}/venv/bin/pip-audit`;
const PROJECT_PYTHON = "/work/.venv/bin/python";
const LOCAL_SOURCES = new Set(["directory", "file"]);
const PYTHON_TEST_DIRS = ["tests", "test"];
// Writes argv[2] to the path argv[1] under /work, inside the sandbox (see
// execute.ts's NODE_WRITER).
const PYTHON_WRITER = [
  "import pathlib, sys",
  "path = pathlib.Path(sys.argv[1])",
  "path.parent.mkdir(parents=True, exist_ok=True)",
  "path.write_text(sys.argv[2])",
].join("; ");
const PYTHON_MISMATCH = [
  "# Added by the standards assessment: a deliberately failing test.",
  "def test_standards_deliberate_mismatch():",
  '    assert 1 == 2, "standards assessment: deliberate mismatch"',
  "",
].join("\n");
const LOCK = z.looseObject({
  package: z
    .array(
      z.looseObject({
        name: z.string(),
        source: z.looseObject({ type: z.string() }).optional(),
      }),
    )
    .optional(),
});
const PYPROJECT_SOURCES = z.looseObject({
  tool: z
    .looseObject({
      poetry: z
        .looseObject({ source: z.array(z.unknown()).optional() })
        .optional(),
    })
    .optional(),
});
const PIP_AUDIT_REPORT = z.looseObject({
  dependencies: z.array(
    z.looseObject({
      name: z.string(),
      vulns: z.array(z.looseObject({ id: z.string() })).optional(),
    }),
  ),
});

// The pinned tools file shipped beside this module: python-tools.txt in the
// source, standards-python-tools.txt beside the built entrypoint.
function defaultPythonTools(): string {
  const candidates = ["python-tools.txt", "standards-python-tools.txt"].map(
    (name) => path.join(import.meta.dirname, name),
  );
  const found = candidates.find((file) => fs.existsSync(file));
  return found ?? candidates[0] ?? "python-tools.txt";
}

// Why the source's own package sources keep Poetry from running, or null.
function foreignSource(source: Source): string | null {
  let declared: unknown[] = [];
  let packages: z.infer<typeof LOCK>["package"] = [];
  try {
    const pyproject = PYPROJECT_SOURCES.parse(
      parse(source.read("pyproject.toml") ?? ""),
    );
    declared = pyproject.tool?.poetry?.source ?? [];
    packages = LOCK.parse(parse(source.read("poetry.lock") ?? "")).package;
  } catch {
    return "pyproject.toml or poetry.lock doesn't parse";
  }
  if (declared.length > 0) {
    return "pyproject.toml declares its own package sources";
  }
  const foreign = (packages ?? []).find(
    ({ source: from }) => from !== undefined && !LOCAL_SOURCES.has(from.type),
  );
  if (foreign !== undefined) {
    return `poetry.lock fetches ${foreign.name} from a ${foreign.source?.type ?? "custom"} source`;
  }
  return null;
}

function scanCriterion(result: SandboxRun): Criterion {
  const id = "vulnerabilities.scan";
  let report: z.infer<typeof PIP_AUDIT_REPORT> | null = null;
  try {
    report = PIP_AUDIT_REPORT.parse(JSON.parse(result.stdout));
  } catch {
    report = null;
  }
  if (report === null) {
    return {
      id,
      status: "unverified",
      evidence: `${exited("pip-audit", result, COMMAND_MS)} without a report; no clean scan`,
    };
  }
  const scope = `pip-audit over the installed environment, dev groups included, ${report.dependencies.length} packages`;
  const affected = report.dependencies.filter(
    ({ vulns }) => (vulns ?? []).length > 0,
  );
  if (affected.length === 0) {
    return { id, status: "passed", evidence: `${scope}: no advisories` };
  }
  // pip-audit can list one advisory more than once for a package.
  const ids = [
    ...new Set(
      affected.flatMap(({ name, vulns }) =>
        (vulns ?? []).map((vuln) => `${name} ${vuln.id}`),
      ),
    ),
  ];
  return {
    id,
    status: "failed",
    evidence: `${scope}: ${ids.length} advisory match(es) in ${affected.length} package(s): ${ids.join(", ")}`,
  };
}

function tool(
  name: string,
  shown: readonly string[],
  argv: readonly string[],
  network: boolean,
): Parameters<Steps["run"]>[0] {
  return { name, shown, argv, network };
}

function poetry(
  args: readonly string[],
  network: boolean,
): Parameters<Steps["run"]>[0] {
  return tool(
    `poetry-${args[0] ?? "run"}`,
    ["poetry", ...args],
    [POETRY, ...args],
    network,
  );
}

function failedInstall(evidence: string): Criterion[] {
  return [
    { id: "environment.install", status: "failed", evidence },
    ...unrun(`not run: ${evidence}`).slice(1),
  ];
}

function poetryRuns(
  steps: Steps,
  python: string,
  planted: string,
): Criterion[] {
  const made = steps.run(
    tool(
      "python-venv",
      ["python3", "-m", "venv", `${TOOLS}/venv`],
      [python, "-I", "-m", "venv", `${TOOLS}/venv`],
      false,
    ),
  );
  const pinned = [
    "install",
    "--require-hashes",
    "--only-binary=:all:",
    "--no-deps",
    "-r",
    TOOLS_FILE,
  ];
  let tools = made;
  let setup = "python3 -m venv";
  if (made.exitCode === 0) {
    setup = "pip install --require-hashes";
    tools = steps.run(
      tool(
        "pip-install-tools",
        ["pip", ...pinned],
        [TOOLS_PYTHON, "-m", "pip", ...pinned],
        true,
      ),
    );
  }
  if (tools.exitCode !== 0) {
    return unrun(
      `not run: the pinned poetry and pip-audit couldn't be set up (${exited(setup, tools, COMMAND_MS)})`,
    );
  }
  const check = steps.run(poetry(["check", "--lock"], false));
  if (check.exitCode !== 0) {
    return failedInstall(
      `${exited("poetry check --lock", check, COMMAND_MS)}: poetry.lock doesn't match pyproject.toml`,
    );
  }
  const deps = steps.run(poetry(["install", "--no-root"], true));
  if (deps.exitCode !== 0) {
    return failedInstall(
      `${exited("poetry install --no-root", deps, COMMAND_MS)} installing the locked dependencies, wheels only`,
    );
  }
  const scan = scanCriterion(
    steps.run({
      ...tool(
        "pip-audit",
        ["pip-audit", "--format", "json"],
        [PIP_AUDIT, "--format", "json", "--progress-spinner", "off"],
        true,
      ),
      env: new Map([["PIPAPI_PYTHON_LOCATION", PROJECT_PYTHON]]),
    }),
  );
  const root = steps.run(poetry(["install", "--only-root"], false));
  if (root.exitCode !== 0) {
    const failed = `${exited("poetry install --only-root", root, COMMAND_MS)} with no network`;
    return [
      { id: "environment.install", status: "failed", evidence: failed },
      scan,
      {
        id: "behavior.tests-run",
        status: "unverified",
        evidence: `not run: ${failed}`,
      },
    ];
  }
  const tests = testsRunCriterion({
    shown: "poetry run python -m pytest",
    run: () => steps.run(poetry(["run", "python", "-m", "pytest"], false)),
    plant: () =>
      steps.run(
        tool(
          "write-mismatch",
          ["write-test", planted],
          [python, "-I", "-c", PYTHON_WRITER, planted, PYTHON_MISMATCH],
          false,
        ),
      ),
    planted,
  });
  return [
    {
      id: "environment.install",
      status: "passed",
      evidence:
        "poetry check --lock and poetry install --no-root (wheels only) exited 0, then poetry install --only-root exited 0 with no network",
    },
    scan,
    tests,
  ];
}

// Installs, scans and tests a Python/Poetry source in the sandbox, or says
// why it didn't.
function executePoetry(source: Source, options: Options): Execution {
  if (options.registry === null) {
    return nothingRun(
      null,
      "not run: the assessment ran statically (--static)",
    );
  }
  const index = options.pypiIndex;
  const { sandbox, reason } = openSandbox();
  if (sandbox === null) {
    return nothingRun(
      {
        tool: "bwrap",
        version: null,
        detail: reason,
        registry: index,
        npm: null,
      },
      `not run: no sandbox on this host (${reason})`,
    );
  }
  const { python, reason: noPython } = hostPython();
  const record: SandboxRecord = {
    tool: "bwrap",
    version: sandbox.version,
    detail: `no credentials, empty home, private /tmp and PID namespace; Python ${python?.version ?? "none"} with hash-pinned poetry and pip-audit in a throwaway venv; network only for pip, poetry install --no-root and pip-audit`,
    registry: index,
    npm: null,
  };
  if (python === null) {
    return nothingRun(record, `not run: ${noPython}`);
  }
  if (!source.files.includes("poetry.lock")) {
    return nothingRun(
      record,
      "not run: no poetry.lock for poetry to install from",
    );
  }
  const foreign = foreignSource(source);
  if (foreign !== null) {
    return nothingRun(record, `not run: ${foreign}; only PyPI is fetched from`);
  }
  return inWorkspace(source, (work, cache) => {
    const tools = `${cache}/tools`;
    fs.mkdirSync(tools);
    const steps = new Steps(sandbox, {
      work,
      cache,
      python,
      binds: [
        { from: tools, to: TOOLS, writable: true },
        { from: options.pythonTools, to: TOOLS_FILE, writable: false },
      ],
      env: new Map([
        ["PATH", `${TOOLS}/venv/bin:/usr/bin:/bin`],
        ["PIP_CONFIG_FILE", "/dev/null"],
        ["PIP_INDEX_URL", index],
        ["PIP_DISABLE_PIP_VERSION_CHECK", "1"],
        ["PIP_NO_INPUT", "1"],
        ["POETRY_CONFIG_DIR", "/home/sandbox/.config/pypoetry"],
        ["POETRY_CACHE_DIR", "/cache/poetry"],
        ["POETRY_VIRTUALENVS_IN_PROJECT", "true"],
        ["POETRY_VIRTUALENVS_USE_POETRY_PYTHON", "true"],
        ["POETRY_INSTALLER_ONLY_BINARY", ":all:"],
        ["POETRY_NO_INTERACTION", "1"],
        ["PYTHON_KEYRING_BACKEND", "keyring.backends.null.Keyring"],
      ]),
    });
    return {
      sandbox: record,
      commands: steps.commands,
      logs: steps.logs,
      criteria: poetryRuns(
        steps,
        python.executable,
        `${testFolder(source, PYTHON_TEST_DIRS)}test_standards_mismatch.py`,
      ),
    };
  });
}

export { defaultPythonTools, executePoetry };
