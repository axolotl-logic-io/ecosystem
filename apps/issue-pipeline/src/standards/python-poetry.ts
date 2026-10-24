// The Python/Poetry part of a standards assessment: the project a root
// pyproject.toml declares, and the environment and behavior criteria that
// the source alone can establish. As for Node/npm, installing, running tests
// and scanning advisories would run repository code, so without a
// credential-free sandbox those criteria stay unverified, never passed
// (#129).

import { parse } from "smol-toml";
import { z } from "zod";
import type { Component, Criterion } from "./schema.ts";
import type { Source } from "./source.ts";

const TABLE = z.record(z.string(), z.unknown());
const POETRY = z.looseObject({
  name: z.string().optional(),
  "package-mode": z.boolean().optional(),
  repository: z.string().optional(),
  classifiers: z.array(z.string()).optional(),
  scripts: TABLE.optional(),
  dependencies: TABLE.optional(),
  "dev-dependencies": TABLE.optional(),
  group: z
    .record(z.string(), z.looseObject({ dependencies: TABLE.optional() }))
    .optional(),
});
const PYPROJECT = z.looseObject({
  project: z
    .looseObject({
      name: z.string().optional(),
      "requires-python": z.string().optional(),
      classifiers: z.array(z.string()).optional(),
      urls: TABLE.optional(),
      scripts: TABLE.optional(),
      dependencies: z.array(z.string()).optional(),
    })
    .optional(),
  tool: z.looseObject({ poetry: POETRY.optional() }).optional(),
  "build-system": z
    .looseObject({ "build-backend": z.string().optional() })
    .optional(),
});
type Pyproject = z.infer<typeof PYPROJECT>;

const MANIFEST_FILE = "pyproject.toml";
const LOCKFILE = "poetry.lock";
const VERSION_FILE = ".python-version";
// Poetry's own sections, read from the text when the TOML doesn't parse.
const POETRY_TABLE = /^\s*\[tool\.poetry[\].]/mu;
const POETRY_BACKEND = /^poetry\.core\./u;
const NESTED_MANIFEST = /\/pyproject\.toml$/u;
const TEST_FILE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/u;
const TEST_DEF = /^(?<indent>[ \t]*)(?:async\s+)?def\s+test\w*\s*\(/u;
const INDENT = /^[ \t]*/u;
const COMMENT = /^#/u;
// `poetry new`'s placeholder test, which checks only the version string.
const PLACEHOLDER_BODY = /^assert\s+__version__\s*==\s*(?<q>['"])[^'"]*\k<q>$/u;
// Test files read at most; more are counted without reading.
const MAX_TEST_FILES = 500;
const NO_SANDBOX =
  "not run: assessment runs no repository code without a credential-free sandbox";

interface PoetryProject {
  // The parsed root pyproject.toml, or null when it doesn't parse.
  manifest: Pyproject | null;
  components: Component[];
  // Other pyproject.toml files, which this slice doesn't assess.
  nested: string[];
}

function manifestOf(source: Source): Pyproject | null {
  const text = source.read(MANIFEST_FILE);
  if (text === null) {
    return null;
  }
  try {
    return PYPROJECT.parse(parse(text));
  } catch {
    return null;
  }
}

// Whether the source's root pyproject.toml is a Poetry project: it has a
// [tool.poetry] table or builds with poetry-core.
function isPoetry(source: Source): boolean {
  if (!source.files.includes(MANIFEST_FILE)) {
    return false;
  }
  const manifest = manifestOf(source);
  if (manifest === null) {
    return POETRY_TABLE.test(source.read(MANIFEST_FILE) ?? "");
  }
  const backend = manifest["build-system"]?.["build-backend"] ?? "";
  return manifest.tool?.poetry !== undefined || POETRY_BACKEND.test(backend);
}

function namesIn(...tables: (Record<string, unknown> | undefined)[]): string[] {
  return tables.flatMap((table) => Object.keys(table ?? {}));
}

function componentOf(source: Source, manifest: Pyproject): Component {
  const poetry = manifest.tool?.poetry ?? {};
  const project = manifest.project ?? {};
  const groups = Object.values(poetry.group ?? {}).map(
    (group) => group.dependencies,
  );
  let lockfile: string | null = null;
  if (source.files.includes(LOCKFILE)) {
    lockfile = LOCKFILE;
  }
  return {
    path: ".",
    name: poetry.name ?? project.name ?? null,
    private: poetry["package-mode"] === false,
    lockfile,
    scripts: namesIn(poetry.scripts, project.scripts).sort((a, b) =>
      a.localeCompare(b),
    ),
    dependencies:
      namesIn(poetry.dependencies).filter((name) => name !== "python").length +
      (project.dependencies ?? []).length,
    devDependencies: namesIn(poetry["dev-dependencies"], ...groups).length,
  };
}

function poetryProjectOf(source: Source): PoetryProject {
  const manifest = manifestOf(source);
  const nested = source.files.filter((file) => NESTED_MANIFEST.test(file));
  if (manifest === null) {
    return { manifest, components: [], nested };
  }
  return { manifest, components: [componentOf(source, manifest)], nested };
}

function toolchainCriterion(source: Source, manifest: Pyproject): Criterion {
  const id = "environment.toolchain";
  const { python } = manifest.tool?.poetry?.dependencies ?? {};
  const poetry = z.string().optional().catch(undefined).parse(python);
  if (poetry !== undefined) {
    return {
      id,
      status: "passed",
      evidence: `tool.poetry.dependencies.python is ${JSON.stringify(poetry)}`,
    };
  }
  const requires = manifest.project?.["requires-python"];
  if (requires !== undefined) {
    return {
      id,
      status: "passed",
      evidence: `project.requires-python is ${JSON.stringify(requires)}`,
    };
  }
  if (source.files.includes(VERSION_FILE)) {
    return {
      id,
      status: "passed",
      evidence: `${VERSION_FILE} pins the Python version`,
    };
  }
  return {
    id,
    status: "failed",
    evidence:
      "no tool.poetry.dependencies.python, project.requires-python or .python-version declares the supported Python",
  };
}

function lockfileCriterion(source: Source, manifest: Pyproject): Criterion {
  const id = "environment.lockfile";
  if (source.files.includes(LOCKFILE)) {
    return {
      id,
      status: "passed",
      evidence: `${LOCKFILE} records the resolved environment`,
    };
  }
  const poetry = manifest.tool?.poetry ?? {};
  const project = manifest.project ?? {};
  const classifiers = poetry.classifiers ?? project.classifiers ?? [];
  const library =
    poetry["package-mode"] !== false &&
    (classifiers.length > 0 ||
      poetry.repository !== undefined ||
      project.urls !== undefined);
  if (library) {
    return {
      id,
      status: "not-applicable",
      evidence:
        "a library that declares publishing metadata may omit a committed lockfile",
    };
  }
  return {
    id,
    status: "failed",
    evidence:
      "no committed poetry.lock: the dependency ranges are declared but never resolved",
  };
}

interface TestCount {
  real: number;
  placeholders: number;
}

function bodyAt(
  lines: readonly string[],
  at: number,
  indent: number,
): string[] {
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const depth = INDENT.exec(line)?.[0].length ?? 0;
    if (line.trim() !== "" && depth <= indent) {
      break;
    }
    body.push(line.trim());
  }
  return body.filter((line) => line !== "" && !COMMENT.test(line));
}

function testsIn(text: string): TestCount {
  const lines = text.split("\n");
  const count = { real: 0, placeholders: 0 };
  lines.forEach((line, at) => {
    const found = TEST_DEF.exec(line);
    if (found === null) {
      return;
    }
    const { indent = "" } = found.groups ?? {};
    const body = bodyAt(lines, at, indent.length);
    const [only = ""] = body;
    if (body.length === 1 && PLACEHOLDER_BODY.test(only)) {
      count.placeholders += 1;
    } else {
      count.real += 1;
    }
  });
  return count;
}

function testsCriterion(source: Source): Criterion {
  const id = "behavior.tests";
  const files = source.files.filter((file) => TEST_FILE.test(file));
  const read = files.slice(0, MAX_TEST_FILES);
  const counts = read.map((file) => testsIn(source.read(file) ?? ""));
  const real = counts.reduce((sum, count) => sum + count.real, 0);
  const placeholders = counts.reduce(
    (sum, count) => sum + count.placeholders,
    0,
  );
  if (real > 0) {
    return {
      id,
      status: "passed",
      evidence: `${real} test function(s) in ${files.length} test file(s), not counting ${placeholders} version placeholder(s)`,
    };
  }
  if (files.length > read.length) {
    return {
      id,
      status: "unverified",
      evidence: `${files.length} test files, more than the ${MAX_TEST_FILES} read`,
    };
  }
  if (placeholders > 0) {
    return {
      id,
      status: "failed",
      evidence: `only poetry new's placeholder test_version, which checks the version string: zero tests`,
    };
  }
  return {
    id,
    status: "failed",
    evidence: "no test_*.py or *_test.py file defines a test: zero tests",
  };
}

// The environment and behavior criteria for `project`, in the same order as
// the Node/npm ones.
function poetryCriteria(source: Source, project: PoetryProject): Criterion[] {
  const unrun: Criterion[] = [
    { id: "environment.install", status: "unverified", evidence: NO_SANDBOX },
    {
      id: "vulnerabilities.scan",
      status: "unverified",
      evidence: `${NO_SANDBOX}; no advisory scanner ran, so this is not a clean scan`,
    },
    { id: "behavior.tests-run", status: "unverified", evidence: NO_SANDBOX },
  ];
  const { manifest } = project;
  if (manifest === null) {
    const evidence = "the root pyproject.toml doesn't parse as TOML";
    return [
      { id: "environment.manifest", status: "failed", evidence },
      ...unrun,
    ];
  }
  return [
    {
      id: "environment.manifest",
      status: "passed",
      evidence: "pyproject.toml declares one Poetry project",
    },
    toolchainCriterion(source, manifest),
    lockfileCriterion(source, manifest),
    testsCriterion(source),
    ...unrun,
  ];
}

export type { PoetryProject };
export { isPoetry, poetryCriteria, poetryProjectOf };
