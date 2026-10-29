import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import { type Config, configure, defaults } from "./config.ts";
import { empty, type Snapshot } from "./data.ts";
import { type DashboardApi, type DashboardContext, enabled } from "./host.ts";
import { readWhole } from "./local-files.ts";
import { RetryRequests, type RetryTarget } from "./monitor/retry.ts";
import { MonitorRuntime } from "./monitor/runtime.ts";
import { MonitorView } from "./monitor/view.ts";
import { loadRuntimeRuns } from "./runtime-runs.ts";
import { parse } from "./source-records.ts";
import { registerReadTools } from "./tools.ts";

const configReadBytes = 32_768;
const widgetKey = "workflow-monitor";
class DashboardExtension {
  private readonly pi: DashboardApi;
  private readonly configPath: string;
  private readonly runtime = new MonitorRuntime();
  private registered: boolean;
  private toolsRegistered: boolean;
  private active: boolean;
  private config: Config = configure(null);
  private toolSnapshot: Snapshot = empty;
  private generation = 0;
  private repositories = defaults.repos;
  private retries = new RetryRequests(defaults.repos);
  private opened: Promise<void> | null = null;
  constructor(pi: DashboardApi, configPath: string) {
    this.pi = pi;
    this.registered = false;
    this.toolsRegistered = false;
    this.active = false;
    this.configPath = configPath;
  }
  install(): void {
    this.pi.registerFlag("workflow-dash", {
      type: "boolean",
      default: false,
      description:
        "Opt in to database monitoring with explicit task retry (TUI only)",
    });
    this.pi.on("session_start", async (_event, ctx): Promise<void> => {
      await this.stop(ctx);
      if (ctx.mode !== "tui") {
        return;
      }
      this.registerCommands();
      if (enabled(ctx.mode, this.pi.getFlag("workflow-dash") === true)) {
        await this.activate(ctx);
      }
    });
    this.pi.on("session_shutdown", async (_event, ctx): Promise<void> => {
      await this.stop(ctx);
    });
  }
  private async activate(ctx: DashboardContext): Promise<void> {
    this.generation += 1;
    const { generation } = this;
    const file = await readWhole(this.configPath, configReadBytes);
    let config = configure(null);
    if (file.state === "read") {
      config = configure(parse(file.text));
    }
    if (generation !== this.generation) {
      return;
    }
    this.active = true;
    this.config = config;
    this.repositories = config.repos;
    this.retries = new RetryRequests(config.repos);
    this.registerTools();
    await this.runtime.start(config);
    if (generation !== this.generation) {
      return;
    }
    ctx.ui.setWidget(widgetKey, (_host, theme) => ({
      render: (width: number): string[] => {
        const health = this.runtime.snapshot?.entities.find(
          (item): boolean => item.id === "collector",
        );
        let label = "Work · monitoring unavailable";
        if (health !== undefined) {
          label = "Work · /dash to inspect";
        }
        return [truncateToWidth(theme.fg("muted", label), width)];
      },
      invalidate: (): void => {
        /* Stateless widget; render reads current runtime values. */
      },
    }));
  }
  private async open(ctx: DashboardContext): Promise<void> {
    if (this.opened !== null) {
      return this.opened;
    }
    if (!this.active) {
      await this.activate(ctx);
    }
    const { generation } = this;
    if (!this.active) {
      return;
    }
    const work = ctx.ui
      .custom<void>(
        (host, theme, _keyboard, done) => {
          const view = new MonitorView(host, {
            runtime: this.runtime,
            theme,
            done,
            repositories: this.repositories,
            retry: (target: RetryTarget): Promise<string> =>
              this.retries.request(target),
          });
          function changed(): void {
            host.requestRender();
          }
          this.runtime.changed = changed;
          return {
            render: (width: number): string[] => view.render(width),
            invalidate: (): void => view.invalidate(),
            handleInput: (data: string): void => view.handleInput(data),
            dispose: (): void => {
              if (this.runtime.changed === changed) {
                this.runtime.changed = undefined;
              }
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            row: 0,
            col: 0,
            margin: 0,
          },
        },
      )
      .finally((): void => {
        if (generation === this.generation) {
          this.opened = null;
        }
      });
    this.opened = work;
    return work;
  }
  private async stop(ctx: DashboardContext): Promise<void> {
    this.generation += 1;
    const { active } = this;
    this.active = false;
    this.opened = null;
    await this.runtime.stop();
    if (active) {
      ctx.ui.setWidget(widgetKey, undefined);
    }
  }
  /**
   * Keeps the agent-facing buddy_runs and action_run tools. They read the
   * runtime records on demand; they are not part of the database-backed view.
   */
  private registerTools(): void {
    if (this.toolsRegistered) {
      return;
    }
    registerReadTools(this.pi, {
      active: (): boolean => this.active,
      refresh: async (): Promise<void> => {
        this.toolSnapshot = {
          ...empty,
          runtime: await loadRuntimeRuns(this.config),
        };
      },
      get: (): Snapshot => this.toolSnapshot,
    });
    this.toolsRegistered = true;
  }
  private registerCommands(): void {
    if (this.registered) {
      return;
    }
    this.pi.registerCommand("dash", {
      description: "Combined database-backed work view (/dash off stops reads)",
      handler: async (args: string, ctx: DashboardContext): Promise<void> => {
        if (args.trim() === "off") {
          await this.stop(ctx);
          ctx.ui.notify("Workflow dashboard stopped", "info");
          return;
        }
        await this.open(ctx);
      },
    });
    this.pi.registerShortcut(Key.ctrlShift("j"), {
      description: "Open workflow dashboard",
      handler: (ctx: DashboardContext): Promise<void> => this.open(ctx),
    });
    this.registered = true;
  }
}

export { DashboardExtension };
