// The test and stub files an issue's spec documents, and which of them its
// branch lacks. A restart past spec checks them before it carries on (Axlog,
// 2026-10-16): the spec writer is responsible for the spec, its tests and its
// stubs, so when it wrote them, a missing one stops the issue rather than
// going to the implementer or to a new spec. Until the spec writer writes
// them (#305), the implementer does, so the missing ones are its unfinished
// work. Pure: src/restart-spec.ts reads the spec and the branch's files.

// A spec's Tests section starts at a heading or bold label named Tests and
// ends at the next section.
const TESTS_START = /^\s*(?:#{1,6}\s+Tests\b|[-*]?\s*\*\*Tests\*\*)/u;
const SECTION_START =
  /^\s*(?:#{1,6}\s+\S|[-*]?\s*\*\*(?:Behaviour|Out of scope|Design|Wiki updates|Assumptions|Sources)\b)/u;
const CODE_SPAN = /`(?<text>[^`\s]+)`/gu;
// A `file:line` anchor's tail, such as `:12`, `:12-30` or `:12,40`.
const LINE_ANCHOR = /:\d+(?:[-,]\d+)*$/u;
// A path with at least one directory and an extension.
const FILE_PATH = /^[\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]+$/u;
const GLOB = /[*?[\]{}]/u;
const LINE_END = /\r?\n/u;

// The lines of `spec`'s Tests section.
function testsSection(spec: string): string[] {
  const lines = spec.split(LINE_END);
  const start = lines.findIndex((line) => TESTS_START.test(line));
  if (start < 0) {
    return [];
  }
  const rest = lines.slice(start + 1);
  let end = rest.findIndex((line) => SECTION_START.test(line));
  if (end < 0) {
    end = rest.length;
  }
  return [lines[start] ?? "", ...rest.slice(0, end)];
}

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

// The files `spec` documents: the test files its Tests section names, and the
// paths (not globs) its `files` lists. Each path once, in the order found.
function documentedFiles(spec: string, files: readonly string[]): string[] {
  const listed = files.filter(
    (file) => !(GLOB.test(file) || file.endsWith("/")),
  );
  return [...new Set([...namedPaths(testsSection(spec)), ...listed])];
}

// Whether `file` is in `tracked`, by its path from the repo root or, for a
// spec that names paths from an app's folder, as the end of one.
function isTracked(tracked: readonly string[], file: string): boolean {
  return tracked.some((path) => path === file || path.endsWith(`/${file}`));
}

// The files `spec` documents that `tracked`, the paths of the branch's
// commit, lacks.
function missingSpecFiles(
  spec: string,
  files: readonly string[],
  tracked: readonly string[],
): string[] {
  return documentedFiles(spec, files).filter(
    (file) => !isTracked(tracked, file),
  );
}

export { documentedFiles, missingSpecFiles };
