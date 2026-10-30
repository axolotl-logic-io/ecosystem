// What kind of repository a source is, which decides what an upgrade may do:
// an archived repository gets nothing, a scaffold an archive recommendation,
// a Node/npm or Python/Poetry project the supported checks, and anything
// else is blocked as unsupported, naming the toolchains seen. A name or a
// missing manifest never decides it (#129). A root package.json comes first,
// so a repository with both is assessed as Node/npm.

import { isPoetry } from "./python-poetry.ts";
import type { Disposition } from "./schema.ts";
import type { Source } from "./source.ts";

// Files that alone make no application: licenses, readmes and ignore or
// editor settings.
const SCAFFOLD_FILE =
  /^(?:(?:LICEN[CS]E|COPYING|UNLICENSE|README)(?:[.-][\w.-]*)?|\.gitignore|\.gitattributes|\.editorconfig)$/iu;

// Root manifests and file kinds that name a toolchain this slice can't check.
const MARKERS: readonly (readonly [RegExp, string])[] = [
  [
    /^(?:pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|Pipfile)$/u,
    "python",
  ],
  [/^go\.mod$/u, "go"],
  [/^Cargo\.toml$/u, "rust"],
  [
    /^(?:CMakeLists\.txt|Makefile|meson\.build|configure\.ac)$/u,
    "native-build",
  ],
  [/^(?:Gemfile|.*\.gemspec)$/u, "ruby"],
  [/^(?:pom\.xml|build\.gradle(?:\.kts)?)$/u, "jvm"],
  [/^(?:yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/u, "non-npm-package-manager"],
];
const KINDS: readonly (readonly [RegExp, string])[] = [
  [/\.(?:c|cc|cpp|cxx|h|hpp)$/u, "c-cpp"],
  [/\.(?:glsl|frag|vert|comp|hlsl)$/u, "shader"],
  [/\.(?:html?|css)$/u, "static-web"],
  [/\.(?:json|ya?ml|toml|ini|xml)$/u, "configuration"],
  [/\.py$/u, "python"],
  [/\.rs$/u, "rust"],
  [/\.go$/u, "go"],
];

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function toolchainsOf(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const roots = files.filter((file) => !file.includes("/"));
  for (const [marker, name] of MARKERS) {
    if (roots.some((file) => marker.test(file))) {
      seen.add(name);
    }
  }
  for (const [kind, name] of KINDS) {
    if (files.some((file) => kind.test(baseName(file)))) {
      seen.add(name);
    }
  }
  return [...seen].sort();
}

function scaffoldOnly(files: readonly string[]): boolean {
  return files.every((file) => SCAFFOLD_FILE.test(file));
}

function dispositionOf(source: Source): Disposition {
  const toolchains = toolchainsOf(source.files);
  if (source.archived) {
    return {
      kind: "archived",
      detail:
        "GitHub shows the repository archived; it gets no automatic writes or unarchive",
      toolchains,
    };
  }
  if (source.everyRef().every(scaffoldOnly)) {
    return {
      kind: "scaffold",
      detail: "every branch and tag holds only license, readme or ignore files",
      toolchains,
    };
  }
  if (source.files.includes("package.json")) {
    return {
      kind: "node-npm",
      detail: "a root package.json makes this a Node/npm project",
      toolchains: [
        "node-npm",
        ...toolchains.filter((name) => name !== "node-npm"),
      ],
    };
  }
  if (isPoetry(source)) {
    return {
      kind: "python-poetry",
      detail:
        "a root pyproject.toml declaring a Poetry project makes this a Python/Poetry project",
      toolchains: [
        "python-poetry",
        ...toolchains.filter((name) => name !== "python-poetry"),
      ],
    };
  }
  let named = "no recognized toolchain";
  if (toolchains.length > 0) {
    named = toolchains.join(", ");
  }
  return {
    kind: "unsupported",
    detail: `useful content without a supported toolchain (${named}); only Node/npm and Python/Poetry are supported, so the upgrade is blocked`,
    toolchains,
  };
}

export { dispositionOf };
