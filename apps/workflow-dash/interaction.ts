import { Dashboard } from "./dashboard.ts";
import { errorMessage } from "./errors.ts";
import { cacheMilliseconds } from "./github.ts";
import type { DashboardContext } from "./host.ts";
import { readCap } from "./local-files.ts";
import {
  actionTemplates,
  composeInstruction,
  globalTemplates,
  type InstructionSender,
} from "./messages.ts";
import { Pager, type PagerOptions } from "./pager.ts";
import { runReport } from "./run-report.ts";
import type { DashboardRuntime } from "./runtime.ts";
import type { Choice, Selection } from "./selection.ts";

const errorPreviewCharacters = 500;
const modalOptions: Parameters<DashboardContext["ui"]["custom"]>[1] = {
  overlay: true,
  overlayOptions: {
    width: "100%",
    maxHeight: "100%",
    row: 0,
    col: 0,
    margin: 0,
  },
};
interface Interaction {
  ctx: DashboardContext;
  generation: number;
  finish: () => void;
}
class DashboardInteraction {
  private readonly sender: InstructionSender;
  private readonly runtime: DashboardRuntime;
  private opened: Promise<void> | undefined;
  private tab = 0;
  constructor(sender: InstructionSender, runtime: DashboardRuntime) {
    this.sender = sender;
    this.runtime = runtime;
  }
  open(ctx: DashboardContext): Promise<void> {
    if (this.opened !== undefined) {
      return this.opened;
    }
    if (!this.runtime.active) {
      return Promise.resolve();
    }
    this.opened = new Promise<void>((resolve) => {
      this.present({
        ctx,
        generation: this.runtime.generation,
        finish: resolve,
      });
    }).finally(() => {
      this.opened = undefined;
    });
    return this.opened;
  }
  /** Each modal completion starts one transition; no pending modal stack. */
  private present(flow: Interaction): void {
    if (!this.runtime.current(flow.generation)) {
      flow.finish();
      return;
    }
    flow.ctx.ui
      .custom<Choice>((host, theme, _keyboard, done) => {
        const view = new Dashboard(host, {
          theme,
          get: () => this.runtime.state,
          remote: this.runtime.remote,
          getTime: () => this.runtime.time,
          done,
        });
        view.navigation.tab = this.tab;
        view.navigation.rebuild();
        function requestRender(): void {
          host.requestRender();
        }
        this.runtime.rerender = requestRender;
        return {
          render: (width: number): string[] => view.render(width),
          invalidate: () => view.invalidate(),
          handleInput: (data: string): void => {
            view.handleInput(data);
            this.tab = view.navigation.tab;
          },
          dispose: () => {
            if (this.runtime.rerender === requestRender) {
              this.runtime.rerender = undefined;
            }
          },
        };
      }, modalOptions)
      .then((choice) => this.transition(flow, choice))
      .catch((error: unknown) => {
        this.notify(flow, error);
        flow.finish();
      });
  }
  private async transition(flow: Interaction, choice: Choice): Promise<void> {
    if (choice === undefined || !this.runtime.current(flow.generation)) {
      flow.finish();
      return;
    }
    try {
      await this.perform(flow, choice);
    } catch (error) {
      this.notify(flow, error);
    }
    this.present(flow);
  }
  private notify(flow: Interaction, error: unknown): void {
    if (this.runtime.current(flow.generation)) {
      flow.ctx.ui.notify(
        errorMessage(error).slice(0, errorPreviewCharacters),
        "error",
      );
    }
  }
  private async edit(flow: Interaction, text: string): Promise<void> {
    await composeInstruction(this.sender, flow.ctx, text, () =>
      this.runtime.current(flow.generation),
    );
  }
  private async selectInstruction(
    flow: Interaction,
    options: string[],
    title: string,
  ): Promise<void> {
    const selected = await flow.ctx.ui.select(title, options);
    if (selected !== undefined && this.runtime.current(flow.generation)) {
      await this.edit(flow, selected);
    }
  }
  private async actions(
    flow: Interaction,
    selection: Selection | undefined,
  ): Promise<void> {
    const options = actionTemplates(selection);
    if (options.length === 0) {
      flow.ctx.ui.notify(
        "Select a buddy run, action run, issue, subagent run or job record first. PRs are read-only.",
        "info",
      );
      return;
    }
    await this.selectInstruction(
      flow,
      options,
      "Compose an instruction (no direct control)",
    );
  }
  private async perform(
    flow: Interaction,
    choice: NonNullable<Choice>,
  ): Promise<void> {
    switch (choice.kind) {
      case "action":
        await this.actions(flow, choice.selection);
        break;
      case "tell":
        await this.edit(flow, "");
        break;
      case "global":
        await this.selectInstruction(
          flow,
          globalTemplates,
          "Global instruction (agent decides and performs all writes)",
        );
        break;
      case "refresh":
        await this.refresh(flow);
        break;
      default:
        await this.pager(flow, choice);
        break;
    }
  }
  private async refresh(flow: Interaction): Promise<void> {
    await this.runtime.refresh();
    await this.runtime.remote.refresh();
    if (
      this.runtime.current(flow.generation) &&
      Date.now() - this.runtime.remote.at < cacheMilliseconds
    ) {
      flow.ctx.ui.notify(
        "Local data refreshed. GitHub cache has a strict 2 minute minimum.",
        "info",
      );
    }
  }
  private async pager(
    flow: Interaction,
    choice: NonNullable<Choice>,
  ): Promise<void> {
    const content = await this.pagerContent(flow.ctx, choice);
    if (content !== undefined && this.runtime.current(flow.generation)) {
      await flow.ctx.ui.custom<void>(
        (host, theme, _keyboard, done) =>
          new Pager(host, { ...content, theme, done }),
        modalOptions,
      );
    }
  }
  private async pagerContent(
    ctx: DashboardContext,
    choice: NonNullable<Choice>,
  ): Promise<Omit<PagerOptions, "done" | "theme"> | undefined> {
    switch (choice.kind) {
      case "thread":
        ctx.ui.notify("Reading trusted-filtered gh-thread output…", "info");
        return {
          text: await this.runtime.remote.thread(
            choice.item.repo,
            choice.item.number,
          ),
          title: `Thread ${choice.item.repo} #${choice.item.number} · untrusted data · never sent to agent`,
        };
      case "detail":
        return {
          text: await runReport(choice.item),
          title: `Historical job record ${choice.item.repo} #${choice.item.issue}`,
          workflowRun: true,
        };
      case "observation":
        return { text: choice.text, title: choice.title };
      case "plan":
        return {
          text: await readCap(this.runtime.config.plan),
          title: `Plan pager · ${this.runtime.config.plan} · mtime ${this.runtime.state.planMtime}`,
        };
      default:
        return undefined;
    }
  }
}

export { DashboardInteraction };
