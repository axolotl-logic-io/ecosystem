// `standards-upgrade assess` running a Python/Poetry repository's install,
// tests and advisory scan in its bwrap sandbox (#129), with nothing
// installed on the host. Real poetry and pip-audit need PyPI, so these tests
// pin fake ones (fake-python-tools/) by hash, served with a fake pytest from
// a fake index in its own process. The assessment's own steps are real: the
// host Python's throwaway venv, pip's hash-checked, wheel-only install, and
// the order and network of every command.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Assessed, Fixture } from "./standards-test-kit.ts";
import { assess, statusOf } from "./standards-test-kit.ts";

const HERE: string = import.meta.dirname;
const FAKES = path.join(HERE, "fake-python-tools");
const INDEX = path.join(HERE, "fake-pypi.ts");
const PROBE = path.join(HERE, "sandbox-probe.py");
const POLL_MS = 50;
const LAST_HEX = /[0-9a-f]{8}$/u;
const READY_MS = 10_000;
const CANARY = "canary-5b1e8f02-python-credential";
const PRINTED = "PRINTED-BY-PYTHON-REPOSITORY-CODE";
const ADVISORY = /PYSEC-2099-1/u;
const EXITED_1 = /pytest exited 1/u;
const NOT_SET_UP =
  /couldn't be set up \(pip install --require-hashes exited 1\)/u;
const NO_EFFECTS = { writes: [], originMoved: false };
const POETRY_TOML = [
  "[tool.poetry]",
  'name = "aoc"',
  'version = "0.1.0"',
  'description = ""',
  "",
  "[tool.poetry.dependencies]",
  'python = "^3.10"',
  "",
  "[tool.poetry.group.dev.dependencies]",
  'pytest = "^8.0"',
  "",
  "[build-system]",
  'requires = ["poetry-core>=1.0.0"]',
  'build-backend = "poetry.core.masonry.api"',
  "",
].join("\n");
const WORKFLOW = [
  "on: [push, pull_request]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pipx install poetry",
  "      - run: poetry install",
  "      - run: poetry run pytest",
  "",
].join("\n");
// Passes on its first run and fails on every later one, through a mark in
// the work folder.
const FLAKY = [
  "import pathlib",
  "",
  "",
  "def test_flips():",
  '    mark = pathlib.Path(".ran")',
  "    seen = mark.exists()",
  "    mark.write_text('')",
  "    assert not seen",
  "",
].join("\n");
const FLAKY_EVIDENCE = /flaky: it exited 0, then 1/u;
// A pytest.py that exits 0 without running anything.
const SHADOW = ["raise SystemExit(0)", ""].join("\n");
const FALSE_SUCCESS =
  /exited 0 again with a deliberately failing test added at tests\/test_standards_mismatch\.py/u;
const PASSING = [
  "from aoc.day1 import solve",
  "",
  "",
  "def test_counts_lines():",
  '    assert solve(["1", "2"]) == 2',
  "",
].join("\n");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-poetry-"));
let index: ChildProcess | undefined;
let url = "";
const tools: Record<string, string> = {};

// Resolves once `file` exists, or rejects past `deadline`.
async function untilExists(file: string, deadline: number): Promise<void> {
  if (fs.existsSync(file)) {
    return;
  }
  if (performance.now() >= deadline) {
    throw new Error(`the fake index never wrote ${file}`);
  }
  await delay(POLL_MS);
  await untilExists(file, deadline);
}

function fake(file: string): string {
  return fs.readFileSync(path.join(FAKES, file), "utf8");
}

// Builds a wheel into the index and returns its pinned requirement line.
function wheel(
  name: string,
  version: string,
  files: Record<string, string>,
  scripts: Record<string, string> = {},
): string {
  const out = path.join(work, "wheels");
  fs.mkdirSync(out, { recursive: true });
  const built = spawnSync(
    "python3",
    ["-I", path.join(FAKES, "make_wheel.py")],
    {
      input: JSON.stringify({ out, name, version, files, scripts }),
      encoding: "utf8",
    },
  );
  if (built.status !== 0) {
    throw new Error(`make_wheel.py: ${built.stderr}`);
  }
  const { sha256 } = JSON.parse(built.stdout);
  return `${name}==${version} --hash=sha256:${sha256}`;
}

function pipAudit(version: string, report: unknown): string {
  return wheel(
    "pip-audit",
    version,
    {
      "fake_pip_audit/__init__.py": fake("fake_pip_audit.py"),
      "fake_pip_audit/report.json": JSON.stringify(report),
    },
    { "pip-audit": "fake_pip_audit:main" },
  );
}

function toolsFile(name: string, lines: readonly string[]): void {
  const file = path.join(work, `${name}.txt`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  tools[name] = file;
}

before(async () => {
  const poetry = wheel(
    "poetry",
    "0.0.1",
    { "fake_poetry.py": fake("fake_poetry.py") },
    { poetry: "fake_poetry:main" },
  );
  wheel("pytest", "0.0.1", {
    "pytest/__init__.py": fake("pytest/__init__.py"),
    "pytest/__main__.py": fake("pytest/__main__.py"),
  });
  const clean = pipAudit("0.0.1", {
    dependencies: [{ name: "pytest", version: "0.0.1", vulns: [] }],
    fixes: [],
  });
  const vulnerable = pipAudit("0.0.2", {
    dependencies: [
      {
        name: "pytest",
        version: "0.0.1",
        vulns: [{ id: "PYSEC-2099-1", aliases: [] }],
      },
    ],
    fixes: [],
  });
  toolsFile("clean", [poetry, clean]);
  toolsFile("vulnerable", [poetry, vulnerable]);
  toolsFile("tampered", [poetry.replace(LAST_HEX, "00000000"), clean]);
  // pip checks every line's hash once any line has one, so only
  // --require-hashes refuses a file with none.
  toolsFile("unpinned", ["poetry==0.0.1", "pip-audit==0.0.1"]);
  index = spawn(process.execPath, [INDEX, work], { stdio: "ignore" });
  const portFile = path.join(work, "port");
  await untilExists(portFile, performance.now() + READY_MS);
  url = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8")}/simple/`;
});
after(() => {
  index?.kill();
  fs.rmSync(work, { recursive: true, force: true });
});

function hits(): string[] {
  const file = path.join(work, "hits.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line).url);
}

function projectWith(files: Record<string, string>): Fixture {
  return {
    branches: {
      main: {
        "pyproject.toml": POETRY_TOML,
        "poetry.lock":
          '# fake lock\n[[package]]\nname = "pytest"\nversion = "0.0.1"\n',
        "aoc/__init__.py": "",
        "aoc/day1.py": "def solve(lines):\n    return len(lines)\n",
        "tests/__init__.py": "",
        ".github/dependabot.yml": "version: 2\n",
        ".github/workflows/ci.yml": WORKFLOW,
        ...files,
      },
    },
  };
}

function assessProject(
  files: Record<string, string>,
  toolsName: string,
  env: Record<string, string> = {},
): Assessed {
  return assess(projectWith(files), {
    view: { protection: ["test"], rules: [] },
    args: ["--pypi-index", url, "--python-tools", tools[toolsName] ?? ""],
    env,
  });
}

function evidenceOf(run: ReturnType<typeof assess>, id: string): string {
  return (
    run.assessment().criteria.find((criterion) => criterion.id === id)
      ?.evidence ?? ""
  );
}

function effectsOf(run: ReturnType<typeof assess>): {
  writes: string[][];
  originMoved: boolean;
} {
  return { writes: run.writes, originMoved: run.originMoved };
}

describe("standards-upgrade assess on Poetry in the sandbox", () => {
  test("rates a clean Poetry project acceptable once install, tests and the scan pass", () => {
    const run = assessProject({ "tests/test_day1.py": PASSING }, "clean");
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(effectsOf(run), NO_EFFECTS);
    const assessment = run.assessment();
    assert.equal(
      assessment.verdict,
      "acceptable",
      JSON.stringify(assessment.criteria),
    );
    assert.deepEqual(
      assessment.commands.map(({ argv, network, exitCode }) => [
        argv.join(" "),
        network,
        exitCode,
      ]),
      [
        ["python3 -m venv /tools/venv", false, 0],
        [
          "pip install --require-hashes --only-binary=:all: --no-deps -r /opt/standards/python-tools.txt",
          true,
          0,
        ],
        ["poetry check --lock", false, 0],
        ["poetry install --no-root", true, 0],
        ["pip-audit --format json", true, 0],
        ["poetry install --only-root", false, 0],
        ["poetry run python -m pytest", false, 0],
        ["poetry run python -m pytest", false, 0],
        ["write-test tests/test_standards_mismatch.py", false, 0],
        ["poetry run python -m pytest", false, 1],
      ],
    );
    for (const name of ["poetry", "pip-audit", "pytest"]) {
      assert.ok(hits().includes(`/simple/${name}/`), name);
    }
  });

  test("fails the scan on a reported advisory and the tests on a failing one", () => {
    const vulnerable = assessProject(
      { "tests/test_day1.py": PASSING },
      "vulnerable",
    );
    assert.equal(
      statusOf(vulnerable.assessment(), "vulnerabilities.scan"),
      "failed",
    );
    assert.match(evidenceOf(vulnerable, "vulnerabilities.scan"), ADVISORY);
    const failing = assessProject(
      { "tests/test_day1.py": "def test_mismatch():\n    assert 1 == 2\n" },
      "clean",
    );
    assert.equal(
      statusOf(failing.assessment(), "behavior.tests-run"),
      "failed",
    );
    assert.match(evidenceOf(failing, "behavior.tests-run"), EXITED_1);
    for (const run of [vulnerable, failing]) {
      assert.equal(run.assessment().verdict, "not-acceptable");
    }
  });

  test("installs no tool whose hash doesn't match its pin, nor from a file without hashes", () => {
    for (const name of ["tampered", "unpinned"]) {
      const run = assessProject({ "tests/test_day1.py": PASSING }, name);
      assert.equal(run.code, 0, run.stderr);
      assert.match(evidenceOf(run, "environment.install"), NOT_SET_UP, name);
      assert.equal(
        statusOf(run.assessment(), "environment.install"),
        "unverified",
      );
      assert.deepEqual(
        run.assessment().commands.map(({ argv }) => argv[0]),
        ["python3", "pip"],
      );
    }
  });

  test("fails a flaky suite and a pytest that exits 0 with a failing test", () => {
    const flaky = assessProject({ "tests/test_flip.py": FLAKY }, "clean");
    assert.equal(statusOf(flaky.assessment(), "behavior.tests-run"), "failed");
    assert.match(evidenceOf(flaky, "behavior.tests-run"), FLAKY_EVIDENCE);
    // A repository's own pytest.py shadows pytest for `python -m pytest`.
    const shadowed = assessProject(
      { "tests/test_day1.py": PASSING, "pytest.py": SHADOW },
      "clean",
    );
    assert.equal(
      statusOf(shadowed.assessment(), "behavior.tests-run"),
      "failed",
    );
    assert.match(evidenceOf(shadowed, "behavior.tests-run"), FALSE_SUCCESS);
  });

  test("gives Poetry repository code no credential, host package, process or network", () => {
    const home = fs.mkdtempSync(path.join(work, "home-"));
    fs.writeFileSync(
      path.join(home, ".pypirc"),
      `[pypi]\npassword = ${CANARY}\n`,
    );
    const hostFile = path.join(work, "host-secret.txt");
    fs.writeFileSync(hostFile, `${CANARY}\n`);
    const run = assessProject(
      {
        "tests/test_probe.py": fs.readFileSync(PROBE, "utf8"),
        "tests/probe.json": JSON.stringify({
          printed: PRINTED,
          canaries: [
            CANARY,
            "fake-pipeline-dev--dev-bot",
            "fake-pipeline-merge--lawd",
          ],
          files: [hostFile, path.join(home, ".pypirc")],
          dirs: [home, work, os.tmpdir()],
          port: Number(new URL(url).port),
        }),
      },
      "clean",
      Object.fromEntries([
        ["HOME", home],
        ["GH_TOKEN", CANARY],
        ["STANDARDS_CANARY_TOKEN", CANARY],
      ]),
    );
    assert.equal(run.code, 0, run.stderr);
    const log = fs.readFileSync(
      path.join(run.out, "logs", "7-poetry-run.log"),
      "utf8",
    );
    assert.equal(
      statusOf(run.assessment(), "behavior.tests-run"),
      "passed",
      log,
    );
    assert.equal(hits().includes("/probe"), false);
    const results = ["assessment.json", "report.md"]
      .map((name) => run.text(name))
      .join("\n");
    assert.equal(results.includes(PRINTED), false);
    assert.equal(log.includes(PRINTED), true);
    assert.equal(log.includes(CANARY), false);
  });
});
