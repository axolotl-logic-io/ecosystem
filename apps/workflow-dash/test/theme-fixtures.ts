import { Theme } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

// Pi 1.2 has no public theme loader. Resolve its test-only seam independently
// of npm hoisting; use built-in themes, never a developer's personal theme.
const themeModuleUrl = new URL(
  "./modes/interactive/theme/theme.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const themeModuleSchema = z.object({
  getThemeByName: z.custom<(name: string) => unknown>(
    (value: unknown): boolean => typeof value === "function",
  ),
});
const themeModule = themeModuleSchema.parse(await import(themeModuleUrl.href));

function getThemeByName(name: string): Theme {
  if (name !== "dark" && name !== "light") {
    throw new Error("Use a built-in theme");
  }
  const theme = themeModule.getThemeByName(name);
  if (!(theme instanceof Theme)) {
    throw new Error("Built-in theme unavailable");
  }
  return theme;
}

export { getThemeByName };
