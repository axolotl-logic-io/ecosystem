// The test and stub files an issue's spec documents, and which of them its
// branch lacks. A restart past spec checks them before it carries on (Axlog,
// 2026-10-16): the spec writer is responsible for the spec, its tests and its
// stubs, so when it wrote them, a missing one stops the issue rather than
// going to the implementer or to a new spec. Until the spec writer writes
// them (#305), the implementer does, so the missing ones are its unfinished
// work. Pure: src/restart-spec.ts reads the spec, its interfaces and the
// branch's files.

import type { SpecInterface } from "./roles/spec-writer/reply.ts";
import { specSection } from "./spec-sections.ts";

const CODE_SPAN = /`(?<text>[^`\s]+)`/gu;
// A `file:line` anchor's tail, such as `:12`, `:12-30` or `:12,40`.
const LINE_ANCHOR = /:\d+(?:[-,]\d+)*$/u;
// A path with at least one directory and an extension.
const FILE_PATH = /^[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]+$/u;
const GLOB = /[*?[\]{}]/u;

// The file paths named in code spans on `lines`, without line anchors.
function namedPaths(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    [...line.matchAll(CODE_SPAN)].flatMap((match) => {
      const { text: found = "" } = match.groups ?? {};
      const text = found.replace(LINE_ANCHOR, "");
      if (!FILE_PATH.test(text)) {
        return [];
      }
      return [text];
    }),
  );
}

// The stub paths of the `new` interfaces in `interfaces`: each one's `where`,
// without a line anchor, unless it is a glob or a folder.
function stubPaths(interfaces: readonly SpecInterface[]): string[] {
  return interfaces.flatMap(({ status, where }) => {
    const path = where.replace(LINE_ANCHOR, "");
    if (status !== "new" || GLOB.test(path) || path.endsWith("/")) {
      return [];
    }
    return [path];
  });
}

// The files `spec` documents: the test files its Tests section names, and the
// stubs of its `new` `interfaces`. Each path once, in the order found. Pages
// under `wikiDir`, the wiki checkout's folder, are left out: they are no test
// or stub, and the code checkout never tracks them.
function documentedFiles(
  spec: string,
  interfaces: readonly SpecInterface[],
  wikiDir: string,
): string[] {
  const named = [
    ...namedPaths(specSection(spec, "Tests")),
    ...stubPaths(interfaces),
  ];
  const wikiPrefix = `${wikiDir}/`;
  return [...new Set(named.filter((file) => !file.startsWith(wikiPrefix)))];
}

// Whether `file` is in `tracked`, by its path from the repo root or, for a
// spec that names paths from an app's folder, as the end of one.
function isTracked(tracked: readonly string[], file: string): boolean {
  return tracked.some((path) => path === file || path.endsWith(`/${file}`));
}

// The files `spec` documents that `tracked`, the paths of the branch's
// commit, lacks; `wikiDir` is the wiki checkout's folder, as documentedFiles.
function missingSpecFiles(
  spec: string,
  interfaces: readonly SpecInterface[],
  tracked: readonly string[],
  wikiDir: string,
): string[] {
  return documentedFiles(spec, interfaces, wikiDir).filter(
    (file) => !isTracked(tracked, file),
  );
}

export { documentedFiles, missingSpecFiles };
