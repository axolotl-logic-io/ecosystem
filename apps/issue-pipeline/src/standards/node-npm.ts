// The Node/npm part of a standards assessment: the components a root
// package.json declares, and the environment and behavior criteria that the
// source alone can establish. Installing, running tests and scanning
// advisories would run repository code, so without a credential-free sandbox
// those criteria stay unverified, never passed (#129).

import { z } from "zod";
import type { Component, Criterion } from "./schema.ts";
import type { Source } from "./source.ts";

const MANIFEST = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  main: z.string().optional(),
  exports: z.unknown().optional(),
  bin: z.unknown().optional(),
  engines: z.looseObject({ node: z.string().optional() }).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  workspaces: z
    .union([
      z.array(z.string()),
      z.looseObject({ packages: z.array(z.string()) }),
    ])
    .optional(),
});
type Manifest = z.infer<typeof MANIFEST>;

// npm init's placeholder, which fails without running any test.
const PLACEHOLDER_TEST = /no test specified/u;
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"];
const OTHER_LOCKS = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];
const VERSION_FILES = [".nvmrc", ".node-version"];
const ONE_LEVEL = /^(?<parent>[\w.@-]+(?:\/[\w.@-]+)*)\/\*$/u;
const TRAILING_SLASH = /\/$/u;
const LITERAL = /^[\w.@-]+(?:\/[\w.@-]+)*$/u;
const NO_SANDBOX =
  "not run: assessment runs no repository code without a credential-free sandbox";

interface NodeProject {
  manifest: Manifest | null;
  components: Component[];
  // Workspace patterns this slice can't expand.
  unexpanded: string[];
}

function manifestAt(source: Source, dir: string): Manifest | null {
  const text = source.read(`${dir}package.json`);
  if (text === null) {
    return null;
  }
  try {
    return MANIFEST.parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function lockfileIn(source: Source, dir: string): string | null {
  const found = [...NPM_LOCKS, ...OTHER_LOCKS].find((lock) =>
    source.files.includes(`${dir}${lock}`),
  );
  return found ?? null;
}

function componentOf(
  source: Source,
  dir: string,
  manifest: Manifest,
): Component {
  return {
    path: dir.replace(TRAILING_SLASH, "") || ".",
    name: manifest.name ?? null,
    private: manifest.private === true,
    lockfile: lockfileIn(source, dir),
    scripts: Object.keys(manifest.scripts ?? {}).sort((a, b) =>
      a.localeCompare(b),
    ),
    dependencies: Object.keys(manifest.dependencies ?? {}).length,
    devDependencies: Object.keys(manifest.devDependencies ?? {}).length,
  };
}

function workspaceDirs(source: Source, pattern: string): string[] | null {
  const level = ONE_LEVEL.exec(pattern);
  if (level !== null) {
    const { parent = "" } = level.groups ?? {};
    const depth = parent.split("/").length + 1;
    return source.files
      .filter(
        (file) =>
          file.startsWith(`${parent}/`) && file.endsWith("/package.json"),
      )
      .filter((file) => file.split("/").length === depth + 1)
      .map((file) => file.slice(0, -"package.json".length));
  }
  if (LITERAL.test(pattern)) {
    return [`${pattern}/`];
  }
  return null;
}

function nodeProjectOf(source: Source): NodeProject {
  const manifest = manifestAt(source, "");
  if (manifest === null) {
    return { manifest, components: [], unexpanded: [] };
  }
  const components = [componentOf(source, "", manifest)];
  const unexpanded: string[] = [];
  let patterns = manifest.workspaces ?? [];
  if (!Array.isArray(patterns)) {
    patterns = patterns.packages;
  }
  for (const pattern of patterns) {
    const dirs = workspaceDirs(source, pattern);
    if (dirs === null) {
      unexpanded.push(pattern);
    }
    for (const dir of dirs ?? []) {
      const workspace = manifestAt(source, dir);
      if (workspace !== null) {
        components.push(componentOf(source, dir, workspace));
      }
    }
  }
  return { manifest, components, unexpanded };
}

function toolchainCriterion(source: Source, manifest: Manifest): Criterion {
  const node = manifest.engines?.node;
  if (node !== undefined) {
    return {
      id: "environment.toolchain",
      status: "passed",
      evidence: `engines.node is ${JSON.stringify(node)}`,
    };
  }
  const file = VERSION_FILES.find((name) => source.files.includes(name));
  if (file !== undefined) {
    return {
      id: "environment.toolchain",
      status: "passed",
      evidence: `${file} pins the Node version`,
    };
  }
  return {
    id: "environment.toolchain",
    status: "failed",
    evidence:
      "no engines.node, .nvmrc or .node-version declares the supported Node",
  };
}

function lockfileCriterion(
  manifest: Manifest,
  lockfile: string | null,
): Criterion {
  const id = "environment.lockfile";
  if (lockfile !== null && NPM_LOCKS.includes(lockfile)) {
    return {
      id,
      status: "passed",
      evidence: `${lockfile} records the resolved npm graph`,
    };
  }
  if (lockfile !== null) {
    return {
      id,
      status: "unverified",
      evidence: `${lockfile} belongs to a package manager this slice doesn't check`,
    };
  }
  const library =
    manifest.private !== true &&
    manifest.name !== undefined &&
    manifest.version !== undefined &&
    (manifest.main ?? manifest.exports ?? manifest.bin) !== undefined;
  if (library) {
    return {
      id,
      status: "not-applicable",
      evidence: "a publishable library may omit a committed lockfile",
    };
  }
  return {
    id,
    status: "failed",
    evidence: "an application with no committed package-lock.json",
  };
}

function testsCriterion(manifest: Manifest): Criterion {
  const { test } = manifest.scripts ?? {};
  if (test === undefined || test.trim() === "") {
    return {
      id: "behavior.tests",
      status: "failed",
      evidence: "package.json declares no test script: zero tests",
    };
  }
  if (PLACEHOLDER_TEST.test(test)) {
    return {
      id: "behavior.tests",
      status: "failed",
      evidence: "the test script is npm's placeholder: zero tests",
    };
  }
  return {
    id: "behavior.tests",
    status: "passed",
    evidence: `test script: ${JSON.stringify(test)}`,
  };
}

// The environment and behavior criteria for `project`, in a fixed order.
function nodeCriteria(source: Source, project: NodeProject): Criterion[] {
  const { manifest } = project;
  const unrun: Criterion[] = [
    { id: "environment.install", status: "unverified", evidence: NO_SANDBOX },
    {
      id: "vulnerabilities.scan",
      status: "unverified",
      evidence: `${NO_SANDBOX}; no advisory scanner ran, so this is not a clean scan`,
    },
    { id: "behavior.tests-run", status: "unverified", evidence: NO_SANDBOX },
  ];
  if (manifest === null) {
    const evidence =
      "the root package.json doesn't parse as a package manifest";
    return [
      { id: "environment.manifest", status: "failed", evidence },
      ...unrun,
    ];
  }
  const [root] = project.components;
  return [
    {
      id: "environment.manifest",
      status: "passed",
      evidence: `${project.components.length} component(s) declared`,
    },
    toolchainCriterion(source, manifest),
    lockfileCriterion(manifest, root?.lockfile ?? null),
    testsCriterion(manifest),
    ...unrun,
  ];
}

export type { Manifest, NodeProject };
export { nodeCriteria, nodeProjectOf };
