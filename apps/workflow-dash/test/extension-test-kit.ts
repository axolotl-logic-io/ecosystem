import type {
  DashboardApi,
  DashboardContext,
  LifecycleHandler,
} from "../host.ts";

interface ExtensionHost {
  api: DashboardApi;
  context: DashboardContext;
  handlers: Map<string, LifecycleHandler>;
  events: string[];
}
function extensionHost(
  mode: DashboardContext["mode"],
  flags: Record<string, boolean | string | undefined> = {},
): ExtensionHost {
  const events: string[] = [];
  const handlers = new Map<string, LifecycleHandler>();
  const api: DashboardApi = {
    registerFlag: (name: string): void => {
      events.push(`flag:${name}`);
    },
    getFlag: (name: string) => flags[name],
    on: (
      event: "session_start" | "session_shutdown",
      handler: LifecycleHandler,
    ): void => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string): void => {
      events.push(`command:${name}`);
    },
    registerShortcut: (): void => {
      events.push("shortcut");
    },
    registerTool: (): void => {
      events.push("tool");
    },
    sendUserMessage: (): void => {
      events.push("message");
    },
  };
  const context: DashboardContext = {
    mode,
    isIdle: () => true,
    ui: {
      setWidget: (): void => {
        events.push("widget");
      },
      notify: (): void => {
        events.push("notify");
      },
      editor: () => {
        events.push("editor");
        return Promise.resolve(undefined);
      },
      select: () => {
        events.push("select");
        return Promise.resolve(undefined);
      },
      custom: () => {
        events.push("custom");
        return Promise.reject(new Error("Unexpected modal in host fixture"));
      },
    },
  };
  return { api, context, handlers, events };
}

export type { ExtensionHost };
export { extensionHost };
