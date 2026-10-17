// The helper stubs of a spec writer's change: the files its commits add that
// a `new` interface's stub imports through relative imports, directly or
// through other added files. The commit check lets them change with the
// stubs, so a stub may split into files the spec doesn't list (#416). Reads
// each file at the spec head with the worktree's own `typescript` package;
// without it, no file is a helper.

import { showFile, worktreeTypeScript } from "../../comment-only.ts";

type TypeScript = typeof import("typescript");

// A file whose imports the check reads.
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/u;
// A JavaScript extension a TypeScript import names in place of its source's.
const JS_EXTENSION = /\.(?<module>[cm]?)js(?<jsx>x?)$/u;
const RELATIVE = /^\.\.?\//u;

// The TypeScript source a `.js`, `.mjs`, `.cjs` or `.jsx` path names, or the
// path itself.
function typeScriptSource(target: string): string {
  const match = JS_EXTENSION.exec(target);
  if (match === null) {
    return target;
  }
  const { module = "", jsx = "" } = match.groups ?? {};
  return `${target.slice(0, match.index)}.${module}ts${jsx}`;
}

// The repo paths a relative import `specifier` in `from` may name: the path
// itself, its TypeScript source for a `.js` name, and, with no extension, its
// `.ts`, `.tsx` or `index` file.
function importTargets(from: string, specifier: string): string[] {
  const url = new URL(specifier, `file:///${from}`);
  const target = decodeURIComponent(url.pathname).slice(1);
  return [
    target,
    typeScriptSource(target),
    `${target}.ts`,
    `${target}.tsx`,
    `${target}/index.ts`,
    `${target}/index.tsx`,
  ];
}

// The relative imports of the file `file` holds at `rev`, as repo paths it
// may name.
function relativeImports(
  ts: TypeScript,
  where: { wt: string; rev: string },
  file: string,
): string[] {
  if (!SCRIPT_FILE.test(file)) {
    return [];
  }
  const text = showFile(where.wt, where.rev, file);
  if (text === undefined) {
    return [];
  }
  const { importedFiles } = ts.preProcessFile(text, true, true);
  return importedFiles
    .map((imported) => imported.fileName)
    .filter((specifier) => RELATIVE.test(specifier))
    .flatMap((specifier) => importTargets(file, specifier));
}

// The files of `added`, the files the change adds, that the `stubs` import at
// commit `rev` of the checkout at `wt`, directly or through other added files.
function helperStubs(
  where: { wt: string; rev: string },
  stubs: readonly string[],
  added: readonly string[],
): string[] {
  const ts = worktreeTypeScript(where.wt);
  if (ts === undefined || stubs.length === 0) {
    return [];
  }
  const helpers = new Set<string>();
  const queue = [...stubs];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const target of relativeImports(ts, where, file)) {
      if (
        added.includes(target) &&
        !stubs.includes(target) &&
        !helpers.has(target)
      ) {
        helpers.add(target);
        queue.push(target);
      }
    }
  }
  return [...helpers];
}

export { helperStubs };
