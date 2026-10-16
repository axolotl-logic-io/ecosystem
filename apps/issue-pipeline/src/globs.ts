// Path globs, as the configs write them: `*` matches within one path segment,
// `**` across segments, `**/` any number of leading folders (none included),
// and `?` one character other than `/`.

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/gu;

// The regex source for the glob characters that start at `glob[at]`, and how
// many characters of the glob they used.
function globToken(glob: string, at: number): [string, number] {
  const char = glob.charAt(at);
  if (char === "?") {
    return ["[^/]", 1];
  }
  if (char !== "*") {
    return [char.replace(REGEX_SPECIAL, "\\$&"), 1];
  }
  if (glob.charAt(at + 1) !== "*") {
    return ["[^/]*", 1];
  }
  if (glob.charAt(at + 2) === "/") {
    return ["(?:.*/)?", "**/".length];
  }
  return [".*", "**".length];
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  let at = 0;
  while (at < glob.length) {
    const [part, used] = globToken(glob, at);
    source += part;
    at += used;
  }
  return new RegExp(`^${source}$`, "u");
}

// True when `file` matches any of `globs`; no globs match nothing.
function matchAny(globs: readonly string[] | undefined, file: string): boolean {
  return (globs ?? []).some((glob) => globToRegExp(glob).test(file));
}

const WILDCARD = /[*?[]/u;

// The glob's text before its first wildcard: every path it matches starts so.
function literalPrefix(glob: string): string {
  const at = glob.search(WILDCARD);
  if (at < 0) {
    return glob;
  }
  return glob.slice(0, at);
}

// True when some path may match both globs. It errs towards true: two globs
// with wildcards overlap when one's literal prefix starts the other's, so
// `src/*.ts` overlaps `src/*.md`.
function globsOverlap(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const aWild = WILDCARD.test(a);
  const bWild = WILDCARD.test(b);
  if (!(aWild || bWild)) {
    return false;
  }
  if (!aWild) {
    return matchAny([b], a);
  }
  if (!bWild) {
    return matchAny([a], b);
  }
  const aPrefix = literalPrefix(a);
  const bPrefix = literalPrefix(b);
  return aPrefix.startsWith(bPrefix) || bPrefix.startsWith(aPrefix);
}

// True when any glob of one set overlaps any of the other (globsOverlap).
function fileSetsOverlap(
  as: readonly string[],
  bs: readonly string[],
): boolean {
  return as.some((a) => bs.some((b) => globsOverlap(a, b)));
}

export { fileSetsOverlap, globsOverlap, globToRegExp, matchAny };
