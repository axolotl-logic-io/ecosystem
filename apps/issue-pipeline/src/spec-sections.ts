// A spec's sections, as the spec writer writes them. A section starts at a
// `#`–`######` heading whose text starts with its title, or at a bold label
// naming it, such as `**Tests**`, and ends at the next section start: any
// heading, or a bold label naming one of the spec's sections. Pure.

const HEADING = /^\s*#{1,6}\s+(?<text>\S.*)$/u;
const LABEL = /^\s*[-*]?\s*\*\*(?<text>[^*]+)\*\*/u;
const SECTION_LABEL =
  /^\s*[-*]?\s*\*\*(?:Behaviour|Out of scope|Design|Test interfaces|Tests|Wiki updates|Assumptions|Sources)\b/u;
const WORD_CHAR = /\w/u;
const LINE_END = /\r?\n/u;

// Whether `line` starts the section titled `title`: a heading whose text is
// the title, or starts with it and then a non-word character, or the bold
// label `**<title>**`.
function startsSection(line: string, title: string): boolean {
  const { text: heading } = HEADING.exec(line)?.groups ?? {};
  if (heading?.startsWith(title) === true) {
    return !WORD_CHAR.test(heading.charAt(title.length));
  }
  const { text: label } = LABEL.exec(line)?.groups ?? {};
  return label === title;
}

function startsAnySection(line: string): boolean {
  return HEADING.test(line) || SECTION_LABEL.test(line);
}

// The lines of `spec`'s section titled `title`: its start line, then the lines
// up to the next section start. Empty when the spec has no such section.
function specSection(spec: string, title: string): string[] {
  const lines = spec.split(LINE_END);
  const start = lines.findIndex((line) => startsSection(line, title));
  if (start < 0) {
    return [];
  }
  const rest = lines.slice(start + 1);
  let end = rest.findIndex(startsAnySection);
  if (end < 0) {
    end = rest.length;
  }
  return [lines[start] ?? "", ...rest.slice(0, end)];
}

export { specSection };
