// The installed prompt pages.
import path from "node:path";
import { installRoot } from "../host-paths.ts";

function promptsDir(): string {
  return path.join(installRoot(), "prompts");
}

export { promptsDir };
