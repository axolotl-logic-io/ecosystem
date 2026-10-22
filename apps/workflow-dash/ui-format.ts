import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const secondsPerMinute = 60;
const progressWarning = 0.8;
const defaultBarWidth = 8;
const authorStage = /author/u;
const implementationStage = /implement|develop/u;
const hardeningStage = /review|harden/u;
const mergeStage = /merge/u;
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
function plain(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return "—";
  }
  return JSON.stringify(value);
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
function stageInk(
  stage: string,
): "mdHeading" | "syntaxFunction" | "accent" | "success" | "muted" {
  if (authorStage.test(stage)) {
    return "mdHeading";
  }
  if (implementationStage.test(stage)) {
    return "syntaxFunction";
  }
  if (hardeningStage.test(stage)) {
    return "accent";
  }
  if (mergeStage.test(stage)) {
    return "success";
  }
  return "muted";
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
function durationBar(
  theme: Theme,
  ratio: number,
  width: number,
  ink: Ink = "accent",
): string {
  const filled = Math.min(width, Math.max(0, Math.round(ratio * width)));
  return (
    theme.fg(ink, "▰".repeat(filled)) +
    theme.fg("dim", "▱".repeat(width - filled))
  );
}
function progress(
  theme: Theme,
  ratio: number,
  width = defaultBarWidth,
): string {
  let ink: Ink = "success";
  if (ratio > 1) {
    ink = "error";
  } else if (ratio >= progressWarning) {
    ink = "warning";
  }
  return durationBar(theme, ratio, width, ink);
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
export {
  chip,
  durationBar,
  fmt,
  labelInk,
  layout,
  pad,
  panel,
  pill,
  plain,
  progress,
  shortRepo,
  stageInk,
};
