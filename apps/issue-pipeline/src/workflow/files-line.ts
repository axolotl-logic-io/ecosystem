// The line that names the files a sub-issue touches, which spec's split
// writes at the end of each part's body (spec-split.ts), and its reading,
// which the orchestrator's file holds fall back on when the saved state has
// no files.

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

export { filesLine, filesOfBody };
