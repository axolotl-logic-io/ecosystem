import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import type { MonitorEntity } from "@ecosystem/db/monitoring-protocol";
import { errorMessage } from "../errors.ts";
import { type Badge, chip, pill } from "../ui-format.ts";
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
import { type RetryTarget, retryTarget } from "./retry.ts";
import type { MonitorRuntime } from "./runtime.ts";
import {
  frame,
  type Line,
  line,
  type MonitorTheme,
  raw,
  repoInk,
  type Span,
  sectionBadge,
  sectionInk,
  span,
  stateInk,
} from "./style.ts";

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
const sections = ["ACTIVE", "NEEDS YOU", "PENDING", "SUBAGENTS", "FINISHED"];
const eventInks: Record<string, ThemeColor> = {
  message: "borderAccent",
  reasoning: "syntaxFunction",
  tool: "syntaxType",
  compaction: "mdHeading",
  error: "error",
  policy: "warning",
};
const keySets: Record<"home" | "work" | "trace" | "notices", Badge[]> = {
  home: [
    { icon: "↑↓", text: "select" },
    { icon: "Enter", text: "details" },
    { icon: "f", text: "repository" },
    { icon: "n", text: "notices" },
    { icon: "r", text: "refresh" },
    { icon: "Esc", text: "close" },
  ],
  work: [
    { icon: "↑↓", text: "session" },
    { icon: "Enter", text: "transcript" },
    { icon: "PgUp/PgDn", text: "scroll" },
    { icon: "Esc", text: "back" },
  ],
  trace: [
    { icon: "↑↓", text: "pause/select" },
    { icon: "Enter", text: "expand" },
    { icon: "Tab", text: "filter" },
    { icon: "[", text: "older" },
    { icon: "End", text: "follow" },
    { icon: "PgUp/PgDn", text: "body" },
    { icon: "Esc", text: "back" },
  ],
  notices: [
    { icon: "PgUp/PgDn", text: "scroll" },
    { icon: "n/Esc", text: "back" },
  ],
};
/** Where an action or session's elapsed time stops: now while it runs. */
function endOf(entity: MonitorEntity | null): number {
  if (
    entity?.endedAt === null ||
    entity?.endedAt === undefined ||
    entity.state === "running" ||
    entity.state === "waiting"
  ) {
    return Date.now();
  }
  return Date.parse(entity.endedAt);
}
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
  theme: MonitorTheme;
  done: () => void;
  repositories: string[];
  retry?: (target: RetryTarget) => Promise<string>;
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
interface ViewHost {
  terminal: { rows: number };
  requestRender: () => void;
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
  private retryPending: RetryTarget | null = null;
  private retrying: Promise<void> | null = null;
  private retryMessage: string | null = null;
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
  private selectedRetry(): RetryTarget | null {
    const { snapshot } = this.options.runtime;
    if (snapshot === null || this.panel !== "work") {
      return null;
    }
    let action = this.rows.at(this.selected)?.action;
    if (this.trace !== null || this.work !== null) {
      const session = this.trace ?? this.sessions.at(this.selected);
      action = snapshot.entities.find(
        (entry): boolean => entry.id === session?.parent,
      );
      action ??= this.work?.action;
    }
    return retryTarget(action);
  }
  private async requestRetry(target: RetryTarget): Promise<void> {
    this.retryPending = null;
    this.retryMessage = "Requesting retry on GitHub…";
    this.changed();
    try {
      this.retryMessage =
        (await this.options.retry?.(target)) ??
        "Retry is unavailable in this view.";
    } catch (error) {
      this.retryMessage = safeBody(errorMessage(error));
    } finally {
      this.retrying = null;
      this.changed();
    }
  }
  handleInput(data: string): void {
    const { runtime } = this.options;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.options.done();
      return;
    }
    if (this.retrying !== null) {
      return;
    }
    if (this.retryPending !== null) {
      if (matchesKey(data, "y")) {
        this.retrying = this.requestRetry(this.retryPending);
      } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.retryPending = null;
        this.changed();
      }
      return;
    }
    if (matchesKey(data, "shift+r")) {
      const target = this.selectedRetry();
      if (target === null || this.options.retry === undefined) {
        this.retryMessage =
          "Select a failed task to retry. Running tasks, completed tasks and generic subagents cannot be retried here.";
      } else {
        this.retryPending = target;
        this.retryMessage = null;
      }
      this.changed();
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
  private heading(rows: WorkRow[]): string[] {
    const { theme, runtime } = this.options;
    const { snapshot, error } = runtime;
    let scope = "Ecosystem + Project Buddy";
    if (this.repo !== null) {
      scope = this.repo;
    }
    const title = `${pill(theme, { icon: "\u{f06a9}", text: "WORK" })}  ${theme.fg("muted", `${safeBody(scope)} · live monitoring`)}`;
    const status: string[] = [];
    const health = snapshot?.entities.find(
      (item): boolean => item.id === "collector",
    );
    if (health === undefined) {
      status.push(
        chip(
          theme,
          "◷ Waiting for monitoring data · start the collector",
          "warning",
        ),
      );
    } else {
      const updated = `Updated ${elapsed(health.activityAt, Date.now())} ago`;
      if (
        Date.now() - Date.parse(health.activityAt ?? health.sourceAt) >
        viewSize.staleMilliseconds
      ) {
        status.push(
          chip(theme, `◷ Status delayed · ${updated.toLowerCase()}`, "warning"),
        );
      } else {
        status.push(chip(theme, `● ${updated}`, "success"));
      }
      if (health.state !== "ok") {
        status.push(chip(theme, "partial data · n for notices", "warning"));
      }
    }
    if (snapshot?.partial === true) {
      status.push(chip(theme, "older work beyond 1000 records", "warning"));
    }
    if (error !== null) {
      status.push(chip(theme, safeBody(summary(error)), "error"));
    }
    const counts = sections.map((section): string =>
      chip(
        theme,
        `${rows.filter((row): boolean => row.section === section).length} ${section.toLowerCase()}`,
        sectionInk(section),
      ),
    );
    return [title, status.join(" "), counts.join(" ")];
  }
  /** One work item: its title, then its step, timing and usage. */
  private itemLines(row: WorkRow, selected: boolean): Line[] {
    const { snapshot } = this.options.runtime;
    let marker = "  ";
    if (selected) {
      marker = "› ";
    }
    const first = line(
      span(marker, "accent", true),
      span(
        row.item.repo?.split("/").at(-1) ?? "subagent",
        repoInk(this.options.repositories, row.item.repo),
        true,
      ),
    );
    if (row.item.issue !== null) {
      first.spans.push(span(` #${row.item.issue}`, "accent", true));
    }
    first.spans.push(span(` ${row.item.title}`, "text", selected));
    first.hang = 2;
    const lines = [first];
    const sessionUsage = snapshot?.usage.find(
      (usage): boolean => usage.session === row.session?.id,
    );
    let tokenTotal: number | null = null;
    if (row.action !== null && snapshot !== null) {
      tokenTotal = totalUsage(actionUsage(snapshot, row.action));
    } else if (sessionUsage !== undefined) {
      tokenTotal = totalUsage([sessionUsage]);
    }
    let end = endOf(row.action);
    if (row.item.kind === "session") {
      end = endOf(row.item);
    }
    if (row.action === null && row.session === null) {
      lines.push(
        line(
          span("    "),
          span(summary(row.reason ?? row.state), stateInk(row.state)),
        ),
      );
    } else {
      lines.push(
        line(
          span("    "),
          span(row.action?.actor ?? row.session?.actor ?? "", "text"),
          span(" · ", "dim"),
          span(stepLabel(row), stateInk(row.state), true),
          span("  ", "dim"),
          span(
            elapsed(row.action?.startedAt ?? row.session?.startedAt, end),
            "text",
          ),
          span("  ctx ", "muted"),
          span(compactNumber(sessionUsage?.latest), "syntaxNumber"),
          span(" · tokens ", "muted"),
          span(compactNumber(tokenTotal), "syntaxNumber"),
        ),
      );
    }
    if (row.session !== null && row.section === "ACTIVE") {
      lines.push(
        line(
          span(
            `    Last activity ${elapsed(sessionUsage?.lastActivity ?? row.session.activityAt, Date.now())} ago`,
            "muted",
          ),
        ),
      );
    }
    if (
      row.reason !== null &&
      (row.section === "NEEDS YOU" || row.action?.state === "waiting")
    ) {
      let ink: ThemeColor = "warning";
      if (row.section === "NEEDS YOU") {
        ink = "error";
      }
      lines.push(line(span(`    ${summary(row.reason)}`, ink)));
    }
    return lines.map((entry): Line => ({ ...entry, selected }));
  }
  private home(rows: WorkRow[]): Line[] {
    const { theme, runtime } = this.options;
    const { snapshot } = runtime;
    if (snapshot === null) {
      return [
        line(span("Database-backed monitoring is not available yet.", "muted")),
      ];
    }
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
    const lines: Line[] = [];
    let currentSection = "";
    for (const [index, row] of [...rows.entries()].slice(start)) {
      if (row.section !== currentSection) {
        currentSection = row.section;
        if (lines.length > 0) {
          lines.push(line());
        }
        const count = rows.filter(
          (entry): boolean => entry.section === row.section,
        ).length;
        lines.push(raw(pill(theme, sectionBadge(row.section, count))));
      }
      lines.push(...this.itemLines(row, index === this.selected));
    }
    if (rows.length === 0) {
      lines.push(
        line(span("No work in the current database selection.", "muted")),
      );
    }
    const warnings = notices(snapshot, this.repo);
    if (warnings.length > 0) {
      lines.push(
        line(),
        raw(
          `${pill(theme, { icon: "!", text: `NOTICES · ${warnings.length}`, ink: "warning" })} ${theme.fg("muted", "n to inspect")}`,
        ),
        ...warnings
          .slice(0, viewSize.notices)
          .map(
            (warning): Line =>
              line(span("  • ", "warning"), span(warning, "warning")),
          ),
      );
    }
    return lines;
  }
  private workDetails(): Line[] {
    const { snapshot } = this.options.runtime;
    if (this.work === null || snapshot === null) {
      return [];
    }
    const { item } = this.work;
    const lines: Line[] = [
      line(
        span(
          item.repo ?? "",
          repoInk(this.options.repositories, item.repo),
          true,
        ),
        span(` #${item.issue}`, "accent", true),
        span(` ${item.title}`, "text", true),
      ),
      line(),
      line(span("TASK ATTEMPTS", "borderAccent", true)),
    ];
    for (const action of newest(
      snapshot.entities.filter(
        (entry): boolean =>
          entry.kind === "action" &&
          entry.repo === item.repo &&
          entry.issue === item.issue,
      ),
    )) {
      lines.push(
        line(
          span("  "),
          span(action.task ?? "task", "syntaxFunction", true),
          span(" · ", "dim"),
          span(action.state, stateInk(action.state), true),
          span(" · ", "dim"),
          span(elapsed(action.startedAt, endOf(action)), "text"),
          span(" · ", "dim"),
          span(
            compactNumber(totalUsage(actionUsage(snapshot, action))),
            "syntaxNumber",
          ),
          span(" tokens", "muted"),
        ),
      );
      if (action.reason !== null) {
        lines.push(line(span(`    ${action.reason}`, stateInk(action.state))));
      }
    }
    lines.push(
      line(),
      line(
        span("SESSIONS", "borderAccent", true),
        span(" · select one to inspect messages", "muted"),
      ),
    );
    const { sessions } = this;
    this.selected = Math.min(this.selected, Math.max(0, sessions.length - 1));
    for (const [index, session] of sessions.entries()) {
      const selected = index === this.selected;
      let marker = "  ";
      if (selected) {
        marker = "› ";
      }
      lines.push({
        spans: [
          span(marker, "accent", true),
          span(session.task ?? "", "syntaxFunction", true),
          span(` › ${session.phase ?? session.title}`, "text"),
          span(" · ", "dim"),
          span(session.state, stateInk(session.state), true),
          span(` · ${session.model ?? "model unavailable"}`, "muted"),
        ],
        selected,
        hang: 2,
      });
    }
    if (sessions.length === 0) {
      lines.push(line(span("No recorded model sessions.", "muted")));
    }
    return lines;
  }
  private usageLines(): Line[] {
    const { runtime } = this.options;
    const { trace } = this;
    if (trace === null) {
      return [];
    }
    const usage = runtime.snapshot?.usage.find(
      (item): boolean => item.session === trace.id,
    );
    const total = totalUsage(
      runtime.snapshot?.usage.filter(
        (item): boolean => item.session === trace.id,
      ) ?? [],
    );
    function metric(label: string, value: number | null | undefined): Span[] {
      return [
        span(` · ${label} `, "muted"),
        span(compactNumber(value), "syntaxNumber"),
      ];
    }
    let follow = span("Paused · End resumes follow", "warning", true);
    if (runtime.following) {
      follow = span("● Following", "success", true);
    }
    return [
      line(
        span(trace.actor ?? trace.title, "text", true),
        span(" · ", "dim"),
        span(trace.model ?? "model unavailable", "syntaxFunction"),
        span(" · ", "dim"),
        span(trace.state, stateInk(trace.state), true),
      ),
      line(
        span("Context ", "muted"),
        span(compactNumber(usage?.latest), "syntaxNumber", true),
        span(" / ", "muted"),
        span(compactNumber(usage?.window ?? trace.window), "syntaxNumber"),
        ...metric("start", usage?.first),
        ...metric("peak", usage?.peak),
        ...metric("target", usage?.target),
      ),
      line(
        span("Tokens ", "muted"),
        span(compactNumber(total), "syntaxNumber", true),
        ...metric("in", usage?.input),
        ...metric("out", usage?.output),
        ...metric("cache read", usage?.cacheRead),
        ...metric("cache write", usage?.cacheWrite),
      ),
      line(
        span(compactNumber(usage?.compactions), "syntaxNumber"),
        span(" compactions · ", "muted"),
        follow,
        span(" · ", "dim"),
        span(filters.at(this.filter) ?? "All", "accent", true),
      ),
      line(),
    ];
  }
  private transcript(): Line[] {
    const { runtime } = this.options;
    if (this.trace === null) {
      return [];
    }
    const lines = this.usageLines();
    const { events } = this;
    const last = events.at(-1)?.sequence ?? 0;
    if (runtime.following && last !== this.followSequence) {
      this.selected = Math.max(0, events.length - 1);
      this.followSequence = last;
    }
    this.selected = Math.min(this.selected, Math.max(0, events.length - 1));
    if (runtime.page.more) {
      lines.push(line(span("[ loads earlier events", "dim")));
    }
    const start = Math.max(0, this.selected - viewSize.precedingEvents);
    for (const [index, row] of [...events.entries()].slice(start)) {
      const { event } = row;
      const selected = index === this.selected;
      let marker = "  ";
      if (selected) {
        marker = "› ";
      }
      let preview =
        event.body.split("\n").find((text): boolean => text.trim() !== "") ??
        "";
      if (this.filter === 2) {
        preview = event.reasoning?.split("\n").at(0) ?? "";
      }
      lines.push({
        spans: [
          span(marker, "accent", true),
          span(event.at?.split("T").at(1)?.split(".").at(0) ?? "—", "dim"),
          span(` ${event.label}`, eventInks[event.kind] ?? "muted", true),
          span(` · ${preview.slice(0, viewSize.preview)}`, "text"),
        ],
        selected,
        hang: 2,
      });
      if (this.expanded === row.sequence) {
        lines.push(
          ...event.body
            .split("\n")
            .map((text): Line => line(span(`    ${text}`))),
        );
        if (event.reasoning !== null) {
          lines.push(
            line(),
            line(span("    Reasoning", "syntaxFunction", true)),
            ...event.reasoning
              .split("\n")
              .map((text): Line => line(span(`    ${text}`, "muted"))),
          );
        }
        return lines;
      }
    }
    if (events.length === 0) {
      lines.push(
        line(
          span(
            "No matching recorded events. Reasoning is available only when the provider exposes it.",
            "muted",
          ),
        ),
      );
    }
    return lines;
  }
  private noticeLines(): Line[] {
    const warnings = notices(
      this.options.runtime.snapshot ?? {
        entities: [],
        usage: [],
        at: "",
        partial: false,
      },
      this.repo,
    );
    if (warnings.length === 0) {
      return [line(span("No current notices.", "muted"))];
    }
    return warnings.map(
      (warning): Line => line(span("• ", "warning"), span(warning, "warning")),
    );
  }
  render(width: number): string[] {
    const height = Math.max(viewSize.minimumHeight, this.host.terminal.rows);
    const { rows } = this;
    let body: Line[];
    let title = `Work · ${rows.length}`;
    let keys = keySets.home;
    if (this.panel === "notices") {
      body = this.noticeLines();
      title = `Notices · ${body.length}`;
      keys = keySets.notices;
    } else if (this.trace !== null) {
      body = this.transcript();
      title = `Transcript · ${safeBody(this.trace.actor ?? this.trace.title)}`;
      keys = keySets.trace;
    } else if (this.work === null) {
      body = this.home(rows);
    } else {
      body = this.workDetails();
      title = `${this.work.item.repo?.split("/").at(-1) ?? ""} #${this.work.item.issue}`;
      keys = keySets.work;
    }
    let offset = 0;
    if (
      this.work !== null ||
      this.expanded !== null ||
      this.panel === "notices"
    ) {
      offset = this.detailOffset;
    }
    if (this.options.retry !== undefined && this.selectedRetry() !== null) {
      keys = [...keys, { icon: "R", text: "retry" }];
    }
    if (this.retryPending !== null) {
      const target = this.retryPending;
      title = "Retry task";
      body = [
        line(
          span(
            `Continue ${target.task} for ${target.repo} #${target.issue}?`,
            "accent",
            true,
          ),
        ),
        line(),
        line(
          span(
            `Apply start:${target.task} using your GitHub account. The replacement continues the existing work; it does not reset the branch.`,
          ),
        ),
        line(
          span(
            "The buddy still checks prerequisites and reconciles any uncertain earlier effects.",
            "muted",
          ),
        ),
      ];
      offset = 0;
      keys = [
        { icon: "y", text: "retry" },
        { icon: "n/Esc", text: "cancel" },
      ];
    }
    const heading = this.heading(rows);
    if (this.retryMessage !== null) {
      heading.push(
        this.options.theme.fg("warning", safeBody(this.retryMessage)),
      );
    }
    return frame(
      this.options.theme,
      { heading, title, body, offset, keys },
      { width, height },
    );
  }
}

export type { MonitorViewOptions };
export { MonitorView };
