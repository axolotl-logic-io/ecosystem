// Compatibility prompt location, owned by the installed host.
import path from "node:path";
import { ROOT } from "../pipeline-root.ts";

const PROMPTS_DIR = path.join(ROOT, "prompts");

export { PROMPTS_DIR };
