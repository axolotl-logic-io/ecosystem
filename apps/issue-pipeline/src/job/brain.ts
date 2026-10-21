// The brain: the caller's clone of the repo's wiki (`--brain-path`), where
// each session's behavioral prompt is a page. A stage job pins the pages its
// stage's sessions read once, before it claims or clones anything: their
// exact bytes, held in memory for the whole job, so an edit to the clone
// mid-job changes no session's prompt. Each pinned page's provenance is its
// path, the sha256 of its bytes, and the clone's git HEAD when it has one.
// A page that is missing, unreadable, empty, not UTF-8 or a single line fails
// the job; there is no bundled fallback. The pinned text is behavior only:
// no session's tools, token, commit scope or authority come from it.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../process.ts";
import type { Stage } from "../stages.ts";
import type { SessionPhase } from "./role-context.ts";
import { STAGE_AGENTS } from "./roles.ts";

// The bound on reading the brain's HEAD, a local read.
const GIT_MS = 30_000;
// The longest page pi can take as one argument: Linux bounds each argument,
// with its NUL, to 128 KiB (MAX_ARG_STRLEN, 131072 bytes).
const PAGE_MAX_BYTES = 131_071;
// The page each session reads, by its stage and phase (null for none). A
// session no entry names has no prompt, so it never starts.
const PROMPT_PAGES: readonly {
  stage: Stage;
  phase: SessionPhase | null;
  page: string;
}[] = [
  { stage: "author", phase: null, page: "Pipeline-Prompt-Author.md" },
  { stage: "implement", phase: null, page: "Pipeline-Prompt-Developer.md" },
  { stage: "review", phase: "hardening", page: "Pipeline-Prompt-Hardening.md" },
  {
    stage: "merge",
    phase: "integration",
    page: "Pipeline-Prompt-Integration.md",
  },
  {
    stage: "merge",
    phase: "security-review",
    page: "Pipeline-Prompt-Security.md",
  },
];

// Where a pinned page came from: its name, its absolute path when pinned,
// the sha256 of the bytes pinned, and the brain's HEAD commit (null when the
// brain isn't a git checkout).
interface PromptProvenance {
  page: string;
  path: string;
  sha256: string;
  head: string | null;
}

// A page as pinned: its text, which is its bytes exactly, and where it came
// from.
interface PinnedPrompt {
  text: string;
  provenance: PromptProvenance;
}

// The pages one stage job pinned.
interface Brain {
  // The prompt of a `stage` session in `phase` (null for none), or null when
  // this job's stage runs no such session.
  promptFor: (stage: Stage, phase: SessionPhase | null) => PinnedPrompt | null;
  // Every page pinned, in its stage's session order.
  pinned: readonly PromptProvenance[];
}

function sessionKey(stage: Stage, phase: SessionPhase | null): string {
  return `${stage}/${phase ?? ""}`;
}

// The HEAD commit of the brain's own git checkout, or null when it isn't
// the top of one (a folder inside another checkout has none of its own).
function headOf(brain: string): string | null {
  const read = run(
    "git",
    ["-C", brain, "rev-parse", "--show-toplevel", "--verify", "HEAD"],
    { allowFail: true, timeoutMs: GIT_MS, cwd: brain },
  );
  const [top = "", head = ""] = read.stdout.trim().split("\n");
  if (read.code !== 0 || top !== fs.realpathSync(brain)) {
    return null;
  }
  return head;
}

// Page `page`'s text in `brain`, or a throw that names it and says why it
// can't be a prompt. A page is a file of the clone's own, never a link that
// could lead out of it to a secret. pi reads an `--append-system-prompt` that names an
// existing file as that file, so a page must be more than one line, and it
// must fit in one argument.
function pageText(
  brain: string,
  page: string,
): { text: string; bytes: Buffer } {
  const file = path.join(brain, page);
  let bytes: Buffer;
  try {
    if (!fs.lstatSync(file).isFile()) {
      throw new Error("it isn't a plain file");
    }
    bytes = fs.readFileSync(file);
  } catch (error: unknown) {
    const message = `--brain-path: can't read ${file}: ${messageOf(error)}`;
    throw new Error(message, { cause: error });
  }
  // Exact: a byte-order mark stays, and bytes that aren't UTF-8 don't
  // survive the round trip.
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`--brain-path: ${file} isn't UTF-8`);
  }
  if (bytes.length > PAGE_MAX_BYTES) {
    throw new Error(`--brain-path: ${file} is over ${PAGE_MAX_BYTES} bytes`);
  }
  if (text.trim() === "" || !text.includes("\n") || text.includes("\0")) {
    throw new Error(`--brain-path: ${file} isn't a prompt page of text`);
  }
  return { text, bytes };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Pins, from the wiki clone at `brainPath`, the page of each session a
// `stage` job runs, or throws naming the first page it can't pin.
function openBrain(brainPath: string, stage: Stage): Brain {
  const brain = path.resolve(brainPath);
  if (fs.statSync(brain, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`--brain-path ${brainPath} isn't a folder`);
  }
  const head = headOf(brain);
  const prompts = new Map<string, PinnedPrompt>();
  for (const { phase } of STAGE_AGENTS[stage].sessions) {
    const page = PROMPT_PAGES.find(
      (entry) => entry.stage === stage && entry.phase === phase,
    )?.page;
    if (page === undefined) {
      throw new Error(`no prompt page for ${sessionKey(stage, phase)}`);
    }
    const { text, bytes } = pageText(brain, page);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const provenance = { page, path: path.join(brain, page), sha256, head };
    prompts.set(sessionKey(stage, phase), { text, provenance });
  }
  return {
    promptFor: (at: Stage, phase: SessionPhase | null): PinnedPrompt | null =>
      prompts.get(sessionKey(at, phase)) ?? null,
    pinned: [...prompts.values()].map(({ provenance }) => provenance),
  };
}

export type { Brain, PinnedPrompt, PromptProvenance };
export { openBrain, PROMPT_PAGES };
