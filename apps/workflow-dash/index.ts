import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DashboardExtension } from "./extension.ts";
import type { DashboardApi } from "./host.ts";

function workflowDashboard(pi: DashboardApi): void {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "workflow-dash.json",
  );
  new DashboardExtension(pi, configPath).install();
}
export default workflowDashboard;
