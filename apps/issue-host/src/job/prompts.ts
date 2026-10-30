// Compatibility prompt location, owned by the installed host.
import path from "node:path";
import { INSTALL_ROOT } from "../host-paths.ts";

const PROMPTS_DIR = path.join(INSTALL_ROOT, "prompts");

export { PROMPTS_DIR };
