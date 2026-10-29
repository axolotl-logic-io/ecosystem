import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import type { ViewHost } from "../selection.ts";
import {
  actionUsage,
  compactNumber,
  elapsed,
  newest,
  notices,
  totalUsage,
  type WorkRow,
  workRows,
} from "./model.ts";
import { safeBody } from "./records.ts";
import type { MonitorRuntime } from "./runtime.ts";

const viewSize = {
  page: 8,
  staleMilliseconds: 30_000,
  precedingRows: 5,
  precedingEvents: 4,
  notices: 5,
  preview: 120,
  minimumHeight: 6,
};
const filters = ["All", "Messages", "Reasoning", "Tools"];
interface MonitorViewOptions {
  runtime: Pick<
    MonitorRuntime,
    | "snapshot"
    | "error"
    | "page"
    | "session"
    | "following"
    | "refresh"
    | "loadPage"
  >;
  theme: Pick<Theme, "fg">;
  done: () => void;
  repositories: string[];
}
/** The first line of a reason, clipped; details show the full text. */
function summary(text: string): string {
  const [first = ""] = text.split("\n");
  if (first.length <= viewSize.preview) {
    return first;
  }
  return `${first.slice(0, viewSize.preview - 1)}…`;
}
/** "implement › review", or the task and its state without repeating the task. */
function stepLabel(row: WorkRow): string {
  const task = row.action?.task;
  if (task === undefined || task === null) {
    return row.state;
  }
  if (row.action?.phase !== null && row.action?.phase !== undefined) {
    return `${task} › ${row.action.phase}`;
  }
  if (row.state.startsWith(task)) {
    return row.state;
  }
  return `${task} ${row.state}`;
}
class MonitorView implements Component {
  private readonly options: MonitorViewOptions;
  private readonly host: ViewHost;
  private repository = 0;
  private selected = 0;
  private work: WorkRow | null = null;
  private trace: MonitorEntity | null = null;
  private expanded: number | null = null;
  private filter = 0;
  private detailOffset = 0;
  private followSequence = 0;
  private panel: "work" | "notices" = "work";
  private homeSelection: string | null = null;
  constructor(host: ViewHost, options: MonitorViewOptions) {
    this.host = host;
    this.options = options;
  }
  invalidate(): void {
    this.followSequence = 0;
  }
  private get repo(): string | null {
    if (this.repository === 0) {
      return null;
    }
    return this.options.repositories.at(this.repository - 1) ?? null;
  }
  private get rows(): WorkRow[] {
    const { snapshot } = this.options.runtime;
    if (snapshot === null) {
      return [];
    }
    return workRows(snapshot, this.repo, Date.now());
  }
  private get sessions(): MonitorEntity[] {
    const { snapshot } = this.options.runtime;
    if (snapshot === null || this.work === null) {
      return [];
    }
    const actions = new Set(
      snapshot.entities
        .filter(
          (item): boolean =>
            item.kind === "action" &&
            item.repo === this.work?.item.repo &&
            item.issue === this.work?.item.issue,
        )
        .map((item): string => item.id),
    );
    return newest(
      snapshot.entities.filter(
        (item): boolean =>
          item.kind === "session" &&
          item.parent !== null &&
          actions.has(item.parent),
      ),
    );
  }
  private get events(): typeof this.options.runtime.page.rows {
    return this.options.runtime.page.rows.filter((row): boolean => {
      if (this.filter === 1) {
        return row.event.kind === "message";
      }
      if (this.filter === 2) {
        return row.event.reasoning !== null;
      }
      if (filters.at(this.filter) === "Tools") {
        return row.event.kind === "tool";
      }
      return true;
    });
  }
  private changed(): void {
    this.host.requestRender();
  }
  private async older(): Promise<void> {
    const { runtime } = this.options;
    const before = runtime.page.rows.at(0)?.sequence;
    if (this.trace === null || before === undefined || !runtime.page.more) {
      return;
    }
    await runtime.loadPage(this.trace.id, before);
    this.selected = Math.max(0, this.events.length - 1);
    this.expanded = null;
    this.detailOffset = 0;
    this.changed();
  }
  private openSession(session: MonitorEntity): void {
    this.trace = session;
    this.selected = 0;
    this.expanded = null;
    this.detailOffset = 0;
    this.followSequence = 0;
    const { runtime } = this.options;
    runtime.following = true;
    runtime.page = { rows: [], more: false };
    runtime.loadPage(session.id).catch(() => null);
  }
  handleInput(data: string): void {
    const { runtime } = this.options;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.options.done();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.panel === "notices") {
        this.panel = "work";
        this.detailOffset = 0;
        this.changed();
        return;
      }
      if (this.trace !== null) {
        this.trace = null;
        runtime.session = null;
        this.expanded = null;
      } else if (this.work === null) {
        this.options.done();
        return;
      } else {
        this.work = null;
      }
      this.selected = 0;
      this.detailOffset = 0;
    } else if (
      matchesKey(data, "n") &&
      this.trace === null &&
      this.work === null
    ) {
      if (this.panel === "work") {
        this.panel = "notices";
      } else {
        this.panel = "work";
      }
      this.detailOffset = 0;
    } else if (matchesKey(data, "r")) {
      runtime.refresh().catch(() => null);
    } else if (
      matchesKey(data, "f") &&
      this.trace === null &&
      this.work === null
    ) {
      this.repository =
        (this.repository + 1) % (this.options.repositories.length + 1);
      this.selected = 0;
      this.homeSelection = null;
    } else if (matchesKey(data, Key.tab) && this.trace !== null) {
      this.filter = (this.filter + 1) % filters.length;
      this.selected = 0;
      this.expanded = null;
    } else if (matchesKey(data, "[") && this.trace !== null) {
      this.older().catch(() => null);
    } else if (matchesKey(data, Key.end) && this.trace !== null) {
      runtime.following = true;
      runtime.loadPage(this.trace.id).catch(() => null);
    } else if (matchesKey(data, Key.pageDown)) {
      this.detailOffset += viewSize.page;
    } else if (matchesKey(data, Key.pageUp)) {
      this.detailOffset = Math.max(0, this.detailOffset - viewSize.page);
      runtime.following = false;
    } else if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      runtime.following = false;
      this.expanded = null;
      this.detailOffset = 0;
    } else if (matchesKey(data, Key.down)) {
      this.selected += 1;
      this.expanded = null;
      this.detailOffset = 0;
    } else if (matchesKey(data, Key.enter)) {
      if (this.trace !== null) {
        const row = this.events.at(this.selected);
        if (row !== undefined) {
          if (this.expanded === row.sequence) {
            this.expanded = null;
          } else {
            this.expanded = row.sequence;
          }
          runtime.following = false;
          this.detailOffset = 0;
        }
      } else if (this.work === null) {
        const row = this.rows.at(this.selected);
        if (row !== undefined) {
          if (row.item.kind === "session") {
            this.openSession(row.item);
          } else {
            this.work = row;
            this.selected = 0;
          }
        }
      } else {
        const session = this.sessions.at(this.selected);
        if (session !== undefined) {
          this.openSession(session);
        }
      }
    }
    if (
      this.work === null &&
      this.trace === null &&
      (matchesKey(data, Key.up) || matchesKey(data, Key.down))
    ) {
      const { rows } = this;
      this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
      this.homeSelection = rows.at(this.selected)?.id ?? null;
    }
    this.changed();
  }
  private header(): string[] {
    const { snapshot, error } = this.options.runtime;
    const lines = ["WORK · Ecosystem + Project Buddy"];
    if (error !== null) {
      lines.push(error);
    }
    const health = snapshot?.entities.find(
      (item): boolean => item.id === "collector",
    );
    if (health === undefined) {
      lines.push(
        "Waiting for monitoring data · run the collector after database setup",
      );
    } else {
      let freshness = `Updated ${elapsed(health.activityAt, Date.now())} ago`;
      if (
        Date.now() - Date.parse(health.activityAt ?? health.sourceAt) >
        viewSize.staleMilliseconds
      ) {
        freshness = `Status delayed · ${freshness.toLowerCase()}`;
      }
      if (health.state !== "ok") {
        freshness += " · partial data (see notices)";
      }
      lines.push(freshness);
    }
    if (snapshot?.partial === true) {
      lines.push("Some older work is outside the 1000-record display bound");
    }
    return lines;
  }
  private home(): string[] {
    const { snapshot } = this.options.runtime;
    if (snapshot === null) {
      return ["", "Database-backed monitoring is not available yet."];
    }
    const { rows } = this;
    const counts = ["ACTIVE", "PENDING", "NEEDS YOU", "FINISHED"].map(
      (section): string =>
        `${rows.filter((row): boolean => row.section === section).length} ${section.toLowerCase()}`,
    );
    let scope = "";
    if (this.repo !== null) {
      scope = `${this.repo} · `;
    }
    const lines = [`${scope}${counts.join(" · ")}`, ""];
    if (this.homeSelection !== null) {
      const index = rows.findIndex(
        (row): boolean => row.id === this.homeSelection,
      );
      if (index >= 0) {
        this.selected = index;
      }
    }
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    this.homeSelection = rows.at(this.selected)?.id ?? null;
    const start = Math.max(0, this.selected - viewSize.precedingRows);
    let currentSection = "";
    for (const [index, row] of [...rows.entries()].slice(start)) {
      if (row.section !== currentSection) {
        currentSection = row.section;
        lines.push("", currentSection);
      }
      let prefix = "  ";
      if (index === this.selected) {
        prefix = "› ";
      }
      const repo = row.item.repo?.split("/").at(-1) ?? "subagent";
      let number = "";
      if (row.item.issue !== null) {
        number = `#${row.item.issue} `;
      }
      lines.push(`${prefix}${repo} ${number}${row.item.title}`);
      const sessionUsage = snapshot.usage.find(
        (usage): boolean => usage.session === row.session?.id,
      );
      let tokenTotal: number | null = null;
      if (row.action !== null) {
        tokenTotal = totalUsage(actionUsage(snapshot, row.action));
      } else if (sessionUsage !== undefined) {
        tokenTotal = totalUsage([sessionUsage]);
      }
      let end = Date.now();
      if (
        row.action?.endedAt !== null &&
        row.action?.endedAt !== undefined &&
        row.action.state !== "running" &&
        row.action.state !== "waiting"
      ) {
        end = Date.parse(row.action.endedAt);
      }
      if (row.item.kind === "session" && row.item.endedAt !== null) {
        end = Date.parse(row.item.endedAt);
      }
      if (row.action === null && row.session === null) {
        lines.push(`    ${summary(row.reason ?? row.state)}`);
      } else {
        lines.push(
          `    ${row.action?.actor ?? row.session?.actor ?? ""} · ${stepLabel(row)}  |  ${elapsed(row.action?.startedAt ?? row.session?.startedAt, end)}  |  ctx ${compactNumber(sessionUsage?.latest)} · tokens ${compactNumber(tokenTotal)}`,
        );
      }
      if (row.session !== null && row.section === "ACTIVE") {
        lines.push(
          `    Last activity ${elapsed(sessionUsage?.lastActivity ?? row.session.activityAt, Date.now())} ago`,
        );
      }
      if (
        row.reason !== null &&
        (row.section === "NEEDS YOU" || row.action?.state === "waiting")
      ) {
        lines.push(`    ${summary(row.reason)}`);
      }
    }
    if (rows.length === 0) {
      lines.push("No work in the current database selection.");
    }
    const warnings = notices(snapshot, this.repo);
    if (warnings.length > 0) {
      lines.push(
        "",
        `NOTICES · ${warnings.length} · n to inspect`,
        ...warnings.slice(0, viewSize.notices),
      );
    }
    return lines;
  }
  private workDetails(): string[] {
    const { snapshot } = this.options.runtime;
    if (this.work === null || snapshot === null) {
      return [];
    }
    const { item } = this.work;
    const lines = [
      `${item.repo} #${item.issue} · ${item.title}`,
      "",
      "TASK ATTEMPTS",
    ];
    for (const action of newest(
      snapshot.entities.filter(
        (entry): boolean =>
          entry.kind === "action" &&
          entry.repo === item.repo &&
          entry.issue === item.issue,
      ),
    )) {
      let end = Date.now();
      if (
        action.endedAt !== null &&
        action.state !== "running" &&
        action.state !== "waiting"
      ) {
        end = Date.parse(action.endedAt);
      }
      lines.push(
        `${action.task} · ${action.state} · ${elapsed(action.startedAt, end)} · ${compactNumber(totalUsage(actionUsage(snapshot, action)))} tokens`,
      );
      if (action.reason !== null) {
        lines.push(action.reason);
      }
    }
    lines.push("", "SESSIONS · select one to inspect messages");
    const { sessions } = this;
    this.selected = Math.min(this.selected, Math.max(0, sessions.length - 1));
    for (const [index, session] of sessions.entries()) {
      let prefix = "  ";
      if (index === this.selected) {
        prefix = "› ";
      }
      lines.push(
        `${prefix}${session.task} › ${session.phase ?? session.title} · ${session.state} · ${session.model ?? "model unavailable"}`,
      );
    }
    if (sessions.length === 0) {
      lines.push("No recorded model sessions.");
    }
    return lines;
  }
  private transcript(): string[] {
    const { runtime } = this.options;
    if (this.trace === null) {
      return [];
    }
    const usage = runtime.snapshot?.usage.find(
      (item): boolean => item.session === this.trace?.id,
    );
    const window = usage?.window ?? this.trace.window;
    let follow = "Paused · End resumes follow";
    if (runtime.following) {
      follow = "Following";
    }
    const lines = [
      `${this.trace.actor ?? this.trace.title} · ${this.trace.model ?? "model unavailable"} · ${this.trace.state}`,
      `Context ${compactNumber(usage?.latest)} / ${compactNumber(window)} · start ${compactNumber(usage?.first)} · peak ${compactNumber(usage?.peak)} · target ${compactNumber(usage?.target)}`,
      `Tokens ${compactNumber(totalUsage(runtime.snapshot?.usage.filter((item): boolean => item.session === this.trace?.id) ?? []))} · in ${compactNumber(usage?.input)} · out ${compactNumber(usage?.output)} · cache read ${compactNumber(usage?.cacheRead)} · cache write ${compactNumber(usage?.cacheWrite)}`,
      `${compactNumber(usage?.compactions)} compactions · ${follow} · ${filters.at(this.filter)}`,
      "",
    ];
    const { events } = this;
    const last = events.at(-1)?.sequence ?? 0;
    if (runtime.following && last !== this.followSequence) {
      this.selected = Math.max(0, events.length - 1);
      this.followSequence = last;
    }
    this.selected = Math.min(this.selected, Math.max(0, events.length - 1));
    if (runtime.page.more) {
      lines.push("[ loads earlier events");
    }
    const start = Math.max(0, this.selected - viewSize.precedingEvents);
    for (const [index, row] of [...events.entries()].slice(start)) {
      const { event } = row;
      let prefix = "  ";
      if (index === this.selected) {
        prefix = "› ";
      }
      let preview =
        event.body.split("\n").find((line): boolean => line.trim() !== "") ??
        "";
      if (this.filter === 2) {
        preview = event.reasoning?.split("\n").at(0) ?? "";
      }
      lines.push(
        `${prefix}${event.at?.split("T").at(1)?.split(".").at(0) ?? "—"} ${event.label} · ${preview.slice(0, viewSize.preview)}`,
      );
      if (this.expanded === row.sequence) {
        let { body } = event;
        if (event.reasoning !== null) {
          body += `\n\nReasoning\n${event.reasoning}`;
        }
        return [
          ...lines,
          ...body.split("\n").map((line): string => `    ${line}`),
        ];
      }
    }
    if (events.length === 0) {
      lines.push(
        "No matching recorded events. Reasoning is available only when the provider exposes it.",
      );
    }
    return lines;
  }
  render(width: number): string[] {
    const { theme } = this.options;
    const height = Math.max(viewSize.minimumHeight, this.host.terminal.rows);
    let body: string[];
    if (this.work === null && this.trace === null) {
      body = this.home();
    } else {
      body = [];
    }
    let footer =
      "↑↓ select · Enter details · f repository · n notices · r refresh · Esc close";
    if (this.work !== null) {
      body = this.workDetails();
      footer = "↑↓ session · Enter transcript · PgUp/PgDn scroll · Esc back";
    }
    if (this.trace !== null) {
      body = this.transcript();
      footer =
        "↑↓ pause/select · Enter expand · Tab filter · [ older · End follow · PgUp/PgDn body · Esc back";
    }
    if (this.panel === "notices") {
      body = [
        "NOTICES",
        "",
        ...notices(
          this.options.runtime.snapshot ?? {
            entities: [],
            usage: [],
            at: "",
            partial: false,
          },
          this.repo,
        ),
      ];
      if (body.length === 2) {
        body.push("No current notices.");
      }
      footer = "PgUp/PgDn scroll · n or Esc back";
    }
    const heading = this.header();
    const available = Math.max(1, height - heading.length - 2);
    let offset = 0;
    if (
      this.work !== null ||
      this.expanded !== null ||
      this.panel === "notices"
    ) {
      offset = this.detailOffset;
    }
    const wrapped = body
      .flatMap((line): string[] =>
        wrapTextWithAnsi(safeBody(line), Math.max(1, width - 2)),
      )
      .slice(offset, offset + available);
    return [
      ...heading.map((line): string => theme.fg("accent", line)),
      ...wrapped,
      "",
      theme.fg("muted", footer),
    ]
      .slice(0, height)
      .map((line): string => truncateToWidth(line, width));
  }
}

export type { MonitorViewOptions };
export { MonitorView };
