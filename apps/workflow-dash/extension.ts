import { Key } from "@earendil-works/pi-tui";
import { type DashboardApi, type DashboardContext, enabled } from "./host.ts";
import { DashboardInteraction } from "./interaction.ts";
import { DashboardRuntime, widgetKey } from "./runtime.ts";
import { registerReadTools } from "./tools.ts";

class DashboardExtension {
  private readonly pi: DashboardApi;
  private readonly configPath: string;
  private readonly runtime = new DashboardRuntime();
  private readonly interaction: DashboardInteraction;
  private readonly registered = new Set<"commands" | "tools">();
  constructor(pi: DashboardApi, configPath: string) {
    this.pi = pi;
    this.configPath = configPath;
    this.interaction = new DashboardInteraction(pi, this.runtime);
  }
  install(): void {
    this.pi.registerFlag("workflow-dash", {
      type: "boolean",
      default: false,
      description: "Opt in to the read-only workflow dashboard (TUI only)",
    });
    this.pi.registerFlag("pipeline-dash", {
      type: "boolean",
      default: false,
      description: "Deprecated: use --workflow-dash",
    });
    this.pi.on("session_start", async (_event, ctx) => {
      this.runtime.stop();
      if (ctx.mode === "tui") {
        this.registerCommands();
        if (
          enabled(
            ctx.mode,
            this.pi.getFlag("workflow-dash") === true ||
              this.pi.getFlag("pipeline-dash") === true,
          )
        ) {
          await this.activate(ctx);
        }
      }
    });
    this.pi.on("session_shutdown", (_event, ctx) => this.stop(ctx));
  }
  private async activate(ctx: DashboardContext): Promise<void> {
    await this.runtime.start(ctx, this.configPath);
    if (this.runtime.active && !this.registered.has("tools")) {
      registerReadTools(this.pi, {
        active: () => this.runtime.active,
        refresh: () => this.runtime.refresh(),
        get: () => this.runtime.state,
      });
      this.registered.add("tools");
    }
  }
  private async open(ctx: DashboardContext): Promise<void> {
    if (!this.runtime.active) {
      await this.activate(ctx);
    }
    await this.interaction.open(ctx);
  }
  private stop(ctx: DashboardContext): void {
    const wasActive = this.runtime.active;
    this.runtime.stop();
    if (wasActive) {
      ctx.ui.setWidget(widgetKey, undefined);
    }
  }
  private registerCommands(): void {
    if (this.registered.has("commands")) {
      return;
    }
    this.pi.registerCommand("dash", {
      description: "Workflow dashboard (`/dash off` stops it)",
      handler: async (args: string, ctx: DashboardContext) => {
        if (args.trim() === "off") {
          this.stop(ctx);
          ctx.ui.notify("Workflow dashboard stopped", "info");
          return;
        }
        await this.open(ctx);
      },
    });
    this.pi.registerShortcut(Key.ctrlShift("j"), {
      description: "Open workflow dashboard",
      handler: (ctx: DashboardContext) => this.open(ctx),
    });
    this.registered.add("commands");
  }
}

export { DashboardExtension };
