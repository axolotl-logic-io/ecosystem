import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";
import { type Config, configure, defaults } from "./config.ts";
import { empty, type Snapshot, snapshot } from "./data.ts";
import { errorMessage } from "./errors.ts";
import { Remote } from "./github.ts";
import type { DashboardContext } from "./host.ts";
import { readCap, safePath } from "./local-files.ts";
import { sessions } from "./session-source.ts";
import { parse } from "./source-records.ts";
import { widget } from "./status-view.ts";
import { timeBreakdown, today } from "./time.ts";
import { fmt } from "./ui-format.ts";

const localRefreshMilliseconds = 15_000;
const debounceMilliseconds = 350;
const configReadBytes = 32_768;
const widgetKey = "pipeline-dash";
interface RuntimeSources {
  snapshot: (config: Config, remote: Remote) => Promise<Snapshot>;
  remote: (config: Config) => Remote;
}
const defaultSources: RuntimeSources = {
  snapshot,
  remote: (config: Config) => new Remote(config),
};
class DashboardRuntime {
  generation = 0;
  state: Snapshot = { ...empty };
  config: Config = { ...defaults };
  remote: Remote = new Remote(this.config);
  time = "Loading time breakdown…";
  rerender: (() => void) | undefined;
  private readonly sources: RuntimeSources;
  private context: DashboardContext | undefined;
  private refreshing: { generation: number; work: Promise<void> } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private watchers: FSWatcher[] = [];
  constructor(sources: RuntimeSources = defaultSources) {
    this.sources = sources;
  }
  stop(): void {
    this.generation += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    if (this.debounce !== undefined) {
      clearTimeout(this.debounce);
    }
    this.timer = undefined;
    this.debounce = undefined;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    this.rerender = undefined;
    this.context = undefined;
    this.refreshing = undefined;
  }
  get active(): boolean {
    return this.context !== undefined;
  }
  current(generation: number): boolean {
    return this.active && generation === this.generation;
  }
  private fail(error: unknown, generation: number): void {
    if (this.current(generation)) {
      this.state = { ...this.state, error: errorMessage(error) };
      this.rerender?.();
    }
  }
  private requestRefresh(): void {
    const { generation } = this;
    this.refresh().catch((error: unknown) => this.fail(error, generation));
  }
  private schedule(): void {
    if (this.active) {
      if (this.debounce !== undefined) {
        clearTimeout(this.debounce);
      }
      this.debounce = setTimeout(
        () => this.requestRefresh(),
        debounceMilliseconds,
      );
    }
  }
  async start(ctx: DashboardContext, configPath: string): Promise<void> {
    this.stop();
    const { generation } = this;
    const config = configure(parse(await readCap(configPath, configReadBytes)));
    if (generation !== this.generation) {
      return;
    }
    this.config = config;
    this.remote = this.sources.remote(config);
    this.context = ctx;
    await this.watchSources(generation);
    if (this.current(generation)) {
      this.timer = setInterval(
        () => this.requestRefresh(),
        localRefreshMilliseconds,
      );
      await this.refresh();
    }
  }
  private async watchSources(generation: number): Promise<void> {
    const roots = [
      { path: this.config.runs, recursive: true },
      { path: this.config.buddyRuns, recursive: true },
      { path: this.config.installed, recursive: false },
      { path: dirname(this.config.hold), recursive: false },
      { path: this.config.plan, recursive: false },
    ];
    const watchers = (
      await Promise.all(
        roots.map(async ({ path, recursive }): Promise<FSWatcher[]> => {
          try {
            const resolved = await safePath(path);
            if (!this.current(generation)) {
              return [];
            }
            const watcher = watch(resolved, { recursive }, () =>
              this.schedule(),
            );
            watcher.on("error", () => watcher.close());
            return [watcher];
          } catch {
            // Polling covers missing paths and unsupported recursive watching.
            return [];
          }
        }),
      )
    ).flat();
    if (this.current(generation)) {
      this.watchers = watchers;
    } else {
      for (const watcher of watchers) {
        watcher.close();
      }
    }
  }
  refresh(): Promise<void> {
    if (!this.active) {
      return Promise.resolve();
    }
    const { generation } = this;
    if (this.refreshing?.generation === generation) {
      return this.refreshing.work;
    }
    const work = this.collect(generation).finally(() => {
      if (this.refreshing?.work === work) {
        this.refreshing = undefined;
      }
    });
    this.refreshing = { generation, work };
    return work;
  }
  private async collect(generation: number): Promise<void> {
    try {
      const next = await this.sources.snapshot(this.config, this.remote);
      if (this.current(generation)) {
        await this.publish(next, generation);
      }
    } catch (error) {
      this.fail(error, generation);
    }
  }
  private async publish(next: Snapshot, generation: number): Promise<void> {
    this.state = next;
    this.context?.ui.setWidget(widgetKey, (_host, theme) =>
      widget(() => this.state, theme),
    );
    this.rerender?.();
    const { remote } = this;
    remote
      .refresh()
      .then(() => {
        if (this.current(generation)) {
          this.state = { ...this.state, main: remote.main };
          this.rerender?.();
        }
      })
      .catch((error: unknown) => this.fail(error, generation));
    const runs = next.workflowRuns.filter(
      (run) => today(run.data.startedAt) || run.live === true,
    );
    const breakdown = timeBreakdown(next.workflowRuns);
    const times = await sessions(runs);
    if (this.current(generation)) {
      this.time = [
        "Today · launch kind / key prefix (consecutive start deltas)",
        ...Object.entries(breakdown.launches).map(
          ([key, value]) => `${key}: ${fmt(value)}`,
        ),
        "",
        "Run stages (jobs.jsonl kind=job, source stages grouped)",
        ...Object.entries(breakdown.types).map(
          ([key, value]) => `${key}: ${fmt(value)}`,
        ),
        "",
        "Session timestamp deltas (toolResult = tool; other message = model)",
        ...Object.entries(times).map(
          ([key, value]) =>
            `${key}: model ${fmt(value.model)} · tool ${fmt(value.tool)}`,
        ),
        "",
        "Capped logs; large-session totals are lower bounds.",
      ].join("\n");
      this.rerender?.();
    }
  }
}

export type { RuntimeSources };
export { DashboardRuntime, widgetKey };
