// The sessions' behavioral prompts: one Markdown page per session kind in
// the pipeline's `prompts/` folder, which ships with the code and which
// install.ts installs as PROMPTS_DIR. A stage job pins the pages its
// stage's sessions read once, before it claims or clones anything: their
// exact bytes, held in memory for the whole job, so an install mid-job
// changes no session's prompt. Each pinned page's provenance is its name,
// its path and the sha256 of its bytes. A page that is missing, unreadable,
// empty, not UTF-8 or a single line fails the job; there is no fallback. The
// pinned text is behavior only: no session's tools, token, commit scope or
// authority come from it.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../pipeline-root.ts";
import type { Stage } from "../stages.ts";
import type { SessionPhase } from "./role-context.ts";
import type { HardeningBuddy } from "./roles.ts";
import { stageAgentOf } from "./roles.ts";
import type { JobTask } from "./task-request.ts";

// The installed release's prompt pages, where a stage job pins them from.
const PROMPTS_DIR: string = path.join(ROOT, "prompts");
// The longest page pi can take as one argument: Linux bounds each argument,
// with its NUL, to 128 KiB (MAX_ARG_STRLEN, 131072 bytes).
const PAGE_MAX_BYTES = 131_071;
// The page each session reads, by its stage and phase (null for none) and,
// for Hardening, the buddy that performs it (an entry naming none serves
// either). A session no entry names has no prompt, so it never starts.
const PROMPT_PAGES: readonly {
  stage: Stage;
  phase: SessionPhase | null;
  hardening?: HardeningBuddy;
  page: string;
}[] = [
  { stage: "author", phase: null, page: "author.md" },
  { stage: "implement", phase: null, page: "developer.md" },
  {
    stage: "review",
    phase: "hardening",
    hardening: "lawd",
    page: "hardening.md",
  },
  {
    stage: "review",
    phase: "hardening",
    hardening: "hippy",
    page: "developer-hardening.md",
  },
  { stage: "merge", phase: "security-review", page: "security.md" },
  // Hippy's Sync resolver, in a Sync task job at either stage Sync runs at.
  { stage: "review", phase: "sync", page: "sync.md" },
  { stage: "merge", phase: "sync", page: "sync.md" },
];

// Where a pinned page came from: its name, its absolute path when pinned and
// the sha256 of the bytes pinned. `head` is always null: the persisted
// records keep the field because a job that pinned its pages from a wiki
// clone recorded the clone's HEAD commit there.
interface PromptProvenance {
  page: string;
  path: string;
  sha256: string;
  head: null;
}

// A page as pinned: its text, which is its bytes exactly, and where it came
// from.
interface PinnedPrompt {
  text: string;
  provenance: PromptProvenance;
}

// The pages one stage job pinned.
interface StagePrompts {
  // The prompt of a `stage` session in `phase` (null for none), or null when
  // this job's stage runs no such session.
  promptFor: (stage: Stage, phase: SessionPhase | null) => PinnedPrompt | null;
  // Every page pinned, in its stage's session order.
  pinned: readonly PromptProvenance[];
}

function sessionKey(stage: Stage, phase: SessionPhase | null): string {
  return `${stage}/${phase ?? ""}`;
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

// Pins, from the prompt folder `dir` (PROMPTS_DIR for a stage job), the page
// of each session a `stage` job, whose Hardening `hardening` performs, or
// its `task` job, runs, or throws naming the first page it can't pin.
function pinPrompts(
  dir: string,
  stage: Stage,
  hardening: HardeningBuddy = "lawd",
  task: JobTask | null = null,
): StagePrompts {
  const folder = path.resolve(dir);
  if (fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(
      `the prompt folder ${folder} isn't a folder; install the pipeline release that ships it`,
    );
  }
  const prompts = new Map<string, PinnedPrompt>();
  for (const { phase } of stageAgentOf(stage, hardening, task).sessions) {
    const page = PROMPT_PAGES.find(
      (entry) =>
        entry.stage === stage &&
        entry.phase === phase &&
        (entry.hardening ?? hardening) === hardening,
    )?.page;
    if (page === undefined) {
      throw new Error(`no prompt page for ${sessionKey(stage, phase)}`);
    }
    const { text, bytes } = pageText(folder, page);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const provenance = {
      page,
      path: path.join(folder, page),
      sha256,
      head: null,
    };
    prompts.set(sessionKey(stage, phase), { text, provenance });
  }
  return {
    promptFor: (at: Stage, phase: SessionPhase | null): PinnedPrompt | null =>
      prompts.get(sessionKey(at, phase)) ?? null,
    pinned: [...prompts.values()].map(({ provenance }) => provenance),
  };
}

export type { PinnedPrompt, PromptProvenance, StagePrompts };
export { PROMPT_PAGES, PROMPTS_DIR, pinPrompts };
