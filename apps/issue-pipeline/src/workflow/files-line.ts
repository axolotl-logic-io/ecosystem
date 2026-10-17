// The line that names the files a sub-issue touches, which spec's split
// writes at the end of each part's body (spec-split.ts), and its reading,
// which the orchestrator's file holds fall back on when the saved state has
// no files (filesOf).

const FILES_LINE = /^Files: (?<named>`[^`\n]+`(?:, `[^`\n]+`)*)[ \t]*$/gmu;
const NAMED_FILE = /`(?<file>[^`\n]+)`/gu;

// The line naming `files`, each in backticks.
function filesLine(files: readonly string[]): string {
  return `Files: ${files.map((file) => `\`${file}\``).join(", ")}`;
}

// The files the body's last files line names, or null when it has none.
function filesOfBody(body: string | null | undefined): string[] | null {
  const last = [...(body ?? "").matchAll(FILES_LINE)].at(-1);
  const { named } = last?.groups ?? {};
  if (named === undefined) {
    return null;
  }
  return [...named.matchAll(NAMED_FILE)].flatMap(({ groups }) => {
    const { file } = groups ?? {};
    return file ?? [];
  });
}

// The files an issue touches: `saved`, those its saved state names, or, when
// it names none (a state saved before restarts kept them), those its body's
// files line names, as a split's sub-issue has; null leaves the whole repo.
function filesOf(
  saved: readonly string[] | null | undefined,
  body: string | null | undefined,
): readonly string[] | null {
  if (saved !== undefined && saved !== null && saved.length > 0) {
    return saved;
  }
  return filesOfBody(body);
}

export { filesLine, filesOf, filesOfBody };
