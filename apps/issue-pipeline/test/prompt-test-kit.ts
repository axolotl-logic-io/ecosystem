// Prompt pages for tests: a pipeline root's prompts/ folder holding the
// behavioral prompt page of every session (PROMPT_PAGES in
// src/job/prompts.ts, which job-prompts.test.ts checks this list against),
// each page's text naming its page, so a test can tell which page a session
// got. It imports no source, so a kit that loads it still sets its root
// before any source loads.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PinnedPrompt } from "../src/job/prompts.ts";

// Each session's stage, phase and page, as the reviewer-flow contract lists
// them.
const PROMPT_PAGES = [
  { stage: "author", phase: null, page: "author.md" },
  { stage: "implement", phase: null, page: "developer.md" },
  { stage: "review", phase: "hardening", page: "hardening.md" },
  { stage: "merge", phase: "security-review", page: "security.md" },
];
// The pages that differ when Hippy, the Developer, hardens
// (`--hardening-buddy hippy`); every other session's page is as above.
const HIPPY_PROMPT_PAGES = [
  { stage: "review", phase: "hardening", page: "developer-hardening.md" },
];
// The page of Hippy's Sync resolver, in a Sync task job at either stage
// Sync runs at (#186).
const SYNC_PROMPT_PAGES = [
  { stage: "review", phase: "sync", page: "sync.md" },
  { stage: "merge", phase: "sync", page: "sync.md" },
];

// The text the test page `page` holds: more than one line, as a prompt page
// must be, naming its page.
function pageTextOf(page: string): string {
  return `# ${page}\n\nThe behavior ${page} prompts.\n`;
}

// The prompt folder of the pipeline root `root`, where a job pins its pages.
function promptsDirOf(root: string): string {
  return path.join(root, "prompts");
}

// Page `page` as a job pins it from the pipeline root `root`.
function pinnedOf(page: string, root = "/root"): PinnedPrompt {
  const text = pageTextOf(page);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const where = path.join(promptsDirOf(root), page);
  const provenance = { page, path: where, sha256, head: null };
  return { text, provenance };
}

// Writes every prompt page into the prompts/ folder of the pipeline root
// `root`, made if missing, and returns that folder.
function writePrompts(root: string): string {
  const dir = promptsDirOf(root);
  fs.mkdirSync(dir, { recursive: true });
  for (const { page } of [
    ...PROMPT_PAGES,
    ...HIPPY_PROMPT_PAGES,
    ...SYNC_PROMPT_PAGES,
  ]) {
    fs.writeFileSync(path.join(dir, page), pageTextOf(page));
  }
  return dir;
}

export {
  HIPPY_PROMPT_PAGES,
  PROMPT_PAGES,
  pageTextOf,
  pinnedOf,
  promptsDirOf,
  SYNC_PROMPT_PAGES,
  writePrompts,
};
