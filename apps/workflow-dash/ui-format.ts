import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const crust: { kind: "rgb"; r: number; g: number; b: number } = {
  kind: "rgb",
  r: 0x11,
  g: 0x11,
  b: 0x1b,
};
type Ink =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "dim"
  | "syntaxFunction"
  | "mdHeading"
  | "borderAccent";
/** The theme parts these helpers draw with. */
type StyleTheme = Pick<Theme, "fg" | "style" | "colors">;
interface Badge {
  icon: string;
  text: string;
  ink?: Ink;
  muted?: boolean;
}
interface Panel {
  title: string;
  content: string[];
  width: number;
  height: number;
  /** Border and title colors; the defaults are a subdued frame. */
  border?: Ink | "borderMuted";
  heading?: Ink;
}
const layout = {
  panelInset: 4,
  frameInset: 2,
};

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
/** Rebuild theme colors at render time; retain no styled strings in state. */
function pill(theme: StyleTheme, badge: Badge): string {
  const color = theme.colors[badge.ink ?? "accent"];
  const body = theme.colors.userMessageBg;
  let foreground: "muted" | "text" = "text";
  if (badge.muted === true) {
    foreground = "muted";
  }
  return (
    theme.style("\ue0b6", { fg: color }) +
    theme.style(`${badge.icon} `, { fg: crust, bg: color }) +
    theme.style(` ${badge.text} `, { fg: foreground, bg: body }) +
    theme.style("\ue0b4", { fg: body })
  );
}
function chip(theme: StyleTheme, text: string, ink: Ink): string {
  return theme.style(` ${text} `, {
    fg: theme.colors[ink],
    bg: "userMessageBg",
    bold: true,
  });
}
function panel(theme: StyleTheme, box: Panel): string[] {
  const {
    width,
    height,
    title,
    content,
    border: ink = "borderMuted",
    heading = "borderAccent",
  } = box;
  const inner = Math.max(0, width - layout.panelInset);
  function border(text: string): string {
    return theme.fg(ink, text);
  }
  const top = truncateToWidth(
    `─ ${title} `,
    Math.max(0, width - layout.frameInset),
  );
  const lines = [
    border("╭") +
      theme.fg(heading, top) +
      border(
        "─".repeat(Math.max(0, width - layout.frameInset - visibleWidth(top))),
      ) +
      border("╮"),
  ];
  for (
    let index = 0;
    index < Math.max(0, height - layout.frameInset);
    index += 1
  ) {
    lines.push(
      `${border("│")} ${pad(content[index] ?? "", inner)} ${border("│")}`,
    );
  }
  lines.push(border(`╰${"─".repeat(Math.max(0, width - layout.frameInset))}╯`));
  return lines.map((line) => truncateToWidth(line, width));
}

export type { Badge, Ink, Panel, StyleTheme };
export { chip, layout, pad, panel, pill };
