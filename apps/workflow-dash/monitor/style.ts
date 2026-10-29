import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type Badge,
  type Ink,
  layout,
  pad,
  panel,
  pill,
} from "../ui-format.ts";
import { safeBody } from "./records.ts";

type MonitorTheme = Pick<Theme, "fg" | "bg" | "bold" | "style" | "colors">;
/** One run of text in one color. Text is sanitized when it is painted. */
interface Span {
  text: string;
  ink?: ThemeColor;
  bold?: boolean;
}
/** Colored spans, or `raw`: already styled text built only from constants and counts. */
interface Line {
  spans: Span[];
  selected?: boolean;
  raw?: string;
  /** Extra indent for wrapped continuation lines, such as under a "› " marker. */
  hang?: number;
}
interface Frame {
  heading: string[];
  title: string;
  body: Line[];
  offset: number;
  keys: Badge[];
}
interface Screen {
  width: number;
  height: number;
}

const frameRows = { border: 2, gap: 1 };
const sectionStyle = new Map<string, { ink: Ink; icon: string }>([
  ["ACTIVE", { ink: "accent", icon: "▶" }],
  ["NEEDS YOU", { ink: "error", icon: "!" }],
  ["PENDING", { ink: "mdHeading", icon: "◷" }],
  ["SUBAGENTS", { ink: "syntaxFunction", icon: "◆" }],
  ["FINISHED", { ink: "success", icon: "✓" }],
]);
const goodStates = /succeeded|passed|landed|closed|merged|done|ok/u;
const badStates = /failed|error|refused|unknown|blocked/u;
const slowStates = /waiting|held|stopped|pending|partial|delayed|interrupted/u;
const liveStates = /running|active|started/u;
const repoInks: ThemeColor[] = ["syntaxFunction", "borderAccent", "syntaxType"];

function span(text: string, ink?: ThemeColor, bold?: boolean): Span {
  const result: Span = { text };
  if (ink !== undefined) {
    result.ink = ink;
  }
  if (bold === true) {
    result.bold = true;
  }
  return result;
}
function line(...spans: Span[]): Line {
  return { spans };
}
function raw(text: string): Line {
  return { spans: [], raw: text };
}
function sectionInk(section: string): Ink {
  return sectionStyle.get(section)?.ink ?? "accent";
}
function sectionBadge(section: string, count: number): Badge {
  return {
    icon: sectionStyle.get(section)?.icon ?? "•",
    text: `${section} · ${count}`,
    ink: sectionInk(section),
  };
}
/** Green for finished, red for failed, yellow for waiting, mauve for live. */
function stateInk(state: string): ThemeColor {
  if (badStates.test(state)) {
    return "error";
  }
  if (slowStates.test(state)) {
    return "warning";
  }
  if (goodStates.test(state)) {
    return "success";
  }
  if (liveStates.test(state)) {
    return "accent";
  }
  return "muted";
}
function repoInk(repositories: string[], repo: string | null): ThemeColor {
  const index = repositories.indexOf(repo ?? "");
  if (index < 0) {
    return "dim";
  }
  return repoInks[index % repoInks.length] ?? "syntaxFunction";
}
function paintSpan(theme: MonitorTheme, part: Span): string {
  let text = safeBody(part.text);
  if (part.bold === true) {
    text = theme.bold(text);
  }
  return theme.fg(part.ink ?? "text", text);
}
/** The spans without their leading spaces, and how many spaces there were. */
function unindent(spans: Span[]): { spans: Span[]; indent: number } {
  let indent = 0;
  let leading = true;
  const rest = spans.map((part): Span => {
    if (!leading) {
      return part;
    }
    const text = part.text.trimStart();
    indent += part.text.length - text.length;
    leading = text === "";
    return { ...part, text };
  });
  return { spans: rest, indent };
}
/**
 * Sanitize, color and wrap one line. Wrapped parts keep the line's indent, plus its hang;
 * a selected line gets a full-width highlight.
 */
function paint(theme: MonitorTheme, row: Line, width: number): string[] {
  if (row.raw !== undefined) {
    return [truncateToWidth(row.raw, width)];
  }
  const { spans, indent } = unindent(row.spans);
  const hang = row.hang ?? 0;
  const text = spans.map((part): string => paintSpan(theme, part)).join("");
  const wrapped = wrapTextWithAnsi(
    text,
    Math.max(1, width - indent - hang),
  ).map((part, index): string => {
    let margin = indent;
    if (index > 0) {
      margin += hang;
    }
    return " ".repeat(margin) + part;
  });
  if (wrapped.length === 0) {
    wrapped.push("");
  }
  if (row.selected !== true) {
    return wrapped;
  }
  return wrapped.map((part): string =>
    theme.bg("selectedBg", pad(part, width)),
  );
}
/** Badges packed greedily into as few rows as fit the width. */
function badgeRows(
  theme: MonitorTheme,
  badges: Badge[],
  width: number,
): string[] {
  const rows: string[] = [];
  for (const badge of badges) {
    const piece = pill(theme, badge);
    const last = rows.at(-1);
    if (last !== undefined && visibleWidth(`${last} ${piece}`) <= width) {
      rows[rows.length - 1] = `${last} ${piece}`;
    } else {
      rows.push(piece);
    }
  }
  return rows;
}
/**
 * The whole screen: heading, one bordered panel and key hints, exactly as tall as the
 * terminal, so the overlay hides the conversation behind it.
 */
function frame(theme: MonitorTheme, view: Frame, screen: Screen): string[] {
  const { width, height } = screen;
  const keys = badgeRows(
    theme,
    view.keys.map(
      (key): Badge => ({ ...key, ink: "borderAccent", muted: true }),
    ),
    width - frameRows.border,
  ).map((row): string => ` ${row}`);
  const heading = view.heading.map((row): string => ` ${row}`);
  const panelHeight = Math.max(
    frameRows.border + 1,
    height - heading.length - keys.length - frameRows.gap,
  );
  const inner = Math.max(1, width - layout.panelInset);
  const content = view.body
    .flatMap((row): string[] => paint(theme, row, inner))
    .slice(view.offset);
  const lines = [
    ...heading,
    ...panel(theme, {
      title: view.title,
      content,
      width,
      height: panelHeight,
      border: "borderAccent",
      heading: "accent",
    }),
    ...keys,
  ];
  while (lines.length < height) {
    lines.push("");
  }
  return lines
    .slice(0, height)
    .map((row): string => truncateToWidth(row, width));
}

export type { Frame, Line, MonitorTheme, Span };
export {
  frame,
  line,
  paint,
  raw,
  repoInk,
  sectionBadge,
  sectionInk,
  span,
  stateInk,
};
