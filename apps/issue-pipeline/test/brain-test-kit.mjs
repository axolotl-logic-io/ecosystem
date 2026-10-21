// @ts-check
// A brain for tests: a folder holding the behavioral prompt page of every
// session (PROMPT_PAGES in src/job/brain.ts, which job-brain.test.mjs checks
// this list against), each page's text naming its page, so a test can tell
// which page a session got. It imports no source, so a kit that loads it
// still sets its root before any source loads.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const GIT_OPTIONS = { timeout: 30_000 };

// Each session's stage, phase and page, as the reviewer-flow contract lists
// them.
const PROMPT_PAGES = [
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

// The text the brain's page `page` holds: more than one line, as a prompt
// page must be, naming its page.
/** @param {string} page @returns {string} */
function pageTextOf(page) {
  return `# ${page}\n\nThe behavior ${page} prompts.\n`;
}

// Page `page` as a job outside a git checkout pins it from brain `dir`.
/** @param {string} page @param {string} [dir] @returns {import("../src/job/brain.ts").PinnedPrompt} */
function pinnedOf(page, dir = "/brain") {
  const text = pageTextOf(page);
  const sha256 = createHash("sha256").update(text).digest("hex");
  const provenance = { page, path: path.join(dir, page), sha256, head: null };
  return { text, provenance };
}

// Writes every prompt page into `dir`, made if missing, and returns `dir`.
/** @param {string} dir @returns {string} */
function writeBrain(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const { page } of PROMPT_PAGES) {
    fs.writeFileSync(path.join(dir, page), pageTextOf(page));
  }
  return dir;
}

// Read both merge-page heads in a child with a controlled Git executable.
// Combined rev-parse queries deliberately print only the root, reproducing
// Git's top-level-without-HEAD output without depending on the host version.
/**
 * @param {{ bin: string, brain: string, rootRead?: { stdout: string, code: number } }} at
 * @param {string} head
 * @param {number} [code]
 * @returns {string}
 */
function headsWithGit(at, head, code = 0) {
  const root = at.rootRead ?? {
    stdout: `${fs.realpathSync(at.brain)}\n`,
    code: 0,
  };
  const git = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--show-toplevel")) {
  process.stdout.write(${JSON.stringify(root.stdout)});
  process.exitCode = ${root.code};
} else {
  process.stdout.write(${JSON.stringify(head)});
  process.exitCode = ${code};
}
`;
  fs.writeFileSync(path.join(at.bin, "git"), git, { mode: 0o755 });
  const source = new URL("../src/job/brain.ts", import.meta.url).href;
  const script = `
import { openBrain } from ${JSON.stringify(source)};
const brain = openBrain(${JSON.stringify(at.brain)}, "merge");
console.log(JSON.stringify(brain.pinned.map(({ head }) => head)));
`;
  const { PATH: searchPath = "" } = process.env;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries([
        ["PATH", `${at.bin}${path.delimiter}${searchPath}`],
      ]),
    },
    timeout: 30_000,
  });
}

/** @param {string} brain @returns {string} */
function commitBrain(brain) {
  execFileSync("git", ["init", "-q", brain], GIT_OPTIONS);
  execFileSync("git", [...GIT, "-C", brain, "add", "."], GIT_OPTIONS);
  execFileSync(
    "git",
    [...GIT, "-C", brain, "commit", "-qm", "pages"],
    GIT_OPTIONS,
  );
  return execFileSync("git", ["-C", brain, "rev-parse", "HEAD"], {
    ...GIT_OPTIONS,
    encoding: "utf8",
  }).trim();
}

export {
  commitBrain,
  headsWithGit,
  PROMPT_PAGES,
  pageTextOf,
  pinnedOf,
  writeBrain,
};
