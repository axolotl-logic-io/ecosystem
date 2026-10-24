import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type DashboardContext = Pick<ExtensionContext, "mode" | "isIdle"> & {
  ui: Pick<
    ExtensionContext["ui"],
    "setWidget" | "notify" | "select" | "editor" | "custom"
  >;
};
type LifecycleHandler = (
  event: unknown,
  ctx: DashboardContext,
) => void | Promise<void>;
type DashboardApi = Pick<
  ExtensionAPI,
  | "registerFlag"
  | "getFlag"
  | "registerCommand"
  | "registerShortcut"
  | "registerTool"
  | "sendUserMessage"
> & {
  on: (
    event: "session_start" | "session_shutdown",
    handler: LifecycleHandler,
  ) => void;
};

function enabled(mode: string, flag: unknown): boolean {
  return mode === "tui" && flag === true;
}

export type { DashboardApi, DashboardContext, LifecycleHandler };
export { enabled };
