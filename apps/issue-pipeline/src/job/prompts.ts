// Pin one task-selected installed prompt page. Exact bytes and provenance
// remain in memory for the session; missing or unsafe pages have no fallback.
// Prompt text grants no tools, credentials, commit scope or task authority.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../pipeline-root.ts";

const PROMPTS_DIR: string = path.join(ROOT, "prompts");
// Linux's per-argument limit includes the trailing NUL.
const PAGE_MAX_BYTES = 131_071;

interface PromptProvenance {
  page: string;
  path: string;
  sha256: string;
}

interface PinnedPrompt {
  text: string;
  provenance: PromptProvenance;
}

// Page `page`'s text in `dir`, or a throw that names it and says why it
// can't be a prompt. A page is a file of the folder's own, never a link that
// could lead out of it to a secret. pi reads an `--append-system-prompt` that
// names an existing file as that file, so a page must be more than one line,
// and it must fit in one argument.
function pageText(dir: string, page: string): { text: string; bytes: Buffer } {
  const file = path.join(dir, page);
  let bytes: Buffer;
  try {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error("it isn't a plain file");
    }
    bytes = fs.readFileSync(file);
  } catch (error: unknown) {
    const message = `can't read prompt page ${file}: ${messageOf(error)}`;
    throw new Error(message, { cause: error });
  }
  // Exact: a byte-order mark stays, and bytes that aren't UTF-8 don't
  // survive the round trip.
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`prompt page ${file} isn't UTF-8`);
  }
  if (bytes.length > PAGE_MAX_BYTES) {
    throw new Error(`prompt page ${file} is over ${PAGE_MAX_BYTES} bytes`);
  }
  if (text.trim() === "" || !text.includes("\n") || text.includes("\0")) {
    throw new Error(`prompt page ${file} isn't a page of text`);
  }
  return { text, bytes };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// The prompt folder `dir`, resolved, or a throw when it isn't a folder.
function promptFolder(dir: string): string {
  const folder = path.resolve(dir);
  if (fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(
      `the prompt folder ${folder} isn't a folder; install the pipeline release that ships it`,
    );
  }
  return folder;
}

// Page `page` of prompt folder `dir`, pinned, or a throw naming why it
// can't be.
function pinPage(dir: string, page: string): PinnedPrompt {
  const folder = promptFolder(dir);
  const { text, bytes } = pageText(folder, page);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    text,
    provenance: { page, path: path.join(folder, page), sha256 },
  };
}

export type { PinnedPrompt, PromptProvenance };
export { PROMPTS_DIR, pinPage };
