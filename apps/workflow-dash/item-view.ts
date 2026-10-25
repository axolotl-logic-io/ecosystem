import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GitHubItem } from "./github.ts";
import type { SubagentRun } from "./subagent-runs.ts";
import { elapsed, ms } from "./time.ts";
import { chip, fmt, labelInk, pad, shortRepo } from "./ui-format.ts";

const unknownRequest = /unknown/u;
const rowWidth = { id: 8, account: 18, activity: 12 };
function pendingRequest(run: SubagentRun): boolean {
  return (
    run.pending !== undefined &&
    run.pending !== "" &&
    run.pending !== "none" &&
    !unknownRequest.test(run.pending)
  );
}
function issueLabels(item: GitHubItem, theme: Theme, display = false): string {
  return (item.labels ?? [])
    .filter((label) => label.name.startsWith("agent:"))
    .map((label) => {
      let { name } = label;
      if (display) {
        name = name.replace("agent:", "");
      }
      return chip(theme, name, labelInk(label.name));
    })
    .join(" ");
}
function issueReference(item: GitHubItem): string {
  let kind = "";
  if (item.isPr === true) {
    kind = "PR ";
  }
  return `${shortRepo(item.repo)} ${kind}#${item.number}`;
}
function issueRow(item: GitHubItem, theme: Theme): string {
  return `${theme.fg("syntaxFunction", "\uea62")} ${issueReference(item)} ${issueLabels(item, theme, true)} ${item.title}`;
}
function issueDetails(item: GitHubItem, theme: Theme, width: number): string[] {
  let hint = "Enter  gh-thread · read-only, never sent to agent";
  if (item.isPr === true) {
    hint = `${item.state ?? "unknown"} · ${item.headRefOid?.slice(0, rowWidth.id) ?? ""}`;
  }
  return [
    theme.fg("accent", issueReference(item)),
    ...wrapTextWithAnsi(item.title, width),
    "",
    issueLabels(item, theme),
    theme.fg("muted", hint),
  ];
}
function subagentInk(run: SubagentRun): "syntaxFunction" | "success" | "error" {
  if (run.state === "running") {
    return "syntaxFunction";
  }
  if (run.state === "complete") {
    return "success";
  }
  return "error";
}
function subagentRow(run: SubagentRun, theme: Theme): string {
  return `${pad(run.id.slice(0, rowWidth.id), rowWidth.id)} ${chip(theme, run.state, subagentInk(run))} ${pad(run.account ?? "unknown account", rowWidth.account)} ${theme.fg("muted", pad(`${fmt(elapsed(run.last ?? run.start))} ago`, rowWidth.activity, true))} ${run.mission}`;
}
function subagentDetails(
  run: SubagentRun,
  theme: Theme,
  width: number,
): string[] {
  let started = "not recorded";
  if (run.start !== undefined) {
    started = new Date(ms(run.start)).toLocaleString();
  }
  const lines = [
    theme.fg("accent", run.id),
    ...wrapTextWithAnsi(
      `Account: ${run.account ?? "unknown"} · source metadata, not authenticated identity`,
      width,
    ),
    ...wrapTextWithAnsi(
      "Generic pi-subagents harness record, not a domain buddy run: it names no buddy, task, action run or parent, and none is inferred.",
      width,
    ),
    chip(theme, run.state, subagentInk(run)),
    theme.fg(
      "muted",
      `Activity ${fmt(elapsed(run.last ?? run.start))} ago · started ${started}`,
    ),
    "",
    ...wrapTextWithAnsi(run.mission, width),
  ];
  if (pendingRequest(run)) {
    lines.push(
      "",
      theme.fg("warning", "◷ Awaiting supervisor"),
      ...wrapTextWithAnsi(run.pending ?? "", width),
    );
  }
  return [
    ...lines,
    "",
    theme.fg("borderAccent", "RECENT OUTPUT · data only"),
    ...wrapTextWithAnsi(run.tail ?? "No output yet", width).map((line) =>
      theme.fg("muted", line),
    ),
  ];
}

export { issueDetails, issueRow, pendingRequest, subagentDetails, subagentRow };
