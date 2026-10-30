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

export { globToRegExp, matchAny };
