import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const secondsPerMinute = 60;
const mergedLabel = /merged/u;
const stoppedLabel = /stopped/u;
const questionLabel = /not-doable|ask/u;
const splitLabel = /split/u;
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
}
const layout = {
  narrow: 65,
  compactRun: 75,
  medium: 90,
  wide: 110,
  gutter: 3,
  panelInset: 4,
  frameInset: 2,
};

function fmt(seconds: number): string {
  return `${Math.floor(seconds / secondsPerMinute)}m${Math.floor(
    seconds % secondsPerMinute,
  )
    .toString()
    .padStart(2, "0")}s`;
}
function shortRepo(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}
function pad(text: string, width: number, right = false): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  const space = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  if (right) {
    return space + clipped;
  }
  return clipped + space;
}
/** Rebuild theme colors at render time; retain no styled strings in state. */
function pill(theme: Theme, badge: Badge): string {
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
function chip(theme: Theme, text: string, ink: Ink): string {
  return theme.style(` ${text} `, {
    fg: theme.colors[ink],
    bg: "userMessageBg",
    bold: true,
  });
}
function labelInk(
  label: string,
): "success" | "error" | "mdHeading" | "accent" | "syntaxFunction" {
  if (mergedLabel.test(label)) {
    return "success";
  }
  if (stoppedLabel.test(label)) {
    return "error";
  }
  if (questionLabel.test(label)) {
    return "mdHeading";
  }
  if (splitLabel.test(label)) {
    return "accent";
  }
  return "syntaxFunction";
}
function panel(theme: Theme, box: Panel): string[] {
  const { width, height, title, content } = box;
  const inner = Math.max(0, width - layout.panelInset);
  function border(text: string): string {
    return theme.fg("borderMuted", text);
  }
  const top = truncateToWidth(
    `─ ${title} `,
    Math.max(0, width - layout.frameInset),
  );
  const lines = [
    border("╭") +
      theme.fg("borderAccent", top) +
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

export type { Badge, Ink, Panel };
export { chip, fmt, labelInk, layout, pad, panel, pill, shortRepo };
