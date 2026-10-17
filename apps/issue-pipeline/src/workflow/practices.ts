// The note that tells a session to read the repo's coding practices (config
// `practices`), and what its role does with them; the spec writer reads their
// digest (config `practicesDigest`) instead, when the config names one.

import type { PracticesConfig, PracticesUse, WorkItem } from "./types.ts";

type PromptItem = Pick<WorkItem, "n" | "paths">;

// The wiki's dir in the worktree when the config names none.
const DEFAULT_WIKI_DIR = "wiki";

// The coding practices that every session that writes code and the first
// reviewers read in full (config `practices`, Axlog, 2026-10-15), and the spec
// writer through their digest when there is one (spec-practices-digest,
// 2026-10-17). They cover all of the repo's code, not only the app an issue
// names, so no step may skip them by reading only the pages that look
// relevant. Each use says what the role does with them.
const PRACTICES_USE: Readonly<Record<PracticesUse, string>> = {
  spec: "The spec must follow them: its Design names the practices that bear on the work, and its Tests meet their test rules. If the work can't follow one, say which rule and why in Design. If following the issue needs an exception only the maintainer can grant, set `decision` to needs-info and ask for it.",
  writer:
    "Every change you make must follow them, tests included. If the task can't be done within one, don't work around it: say which rule and why in your summary.",
  reviewer:
    "A change that breaks a written rule in them is a defect: mark it `blocking`, quote the rule, and cite the file and line. Preferences they don't settle stay `nit`.",
};

function practicesList(cfg: PracticesConfig, item: PromptItem): string {
  const files = (cfg.practices ?? []).map(
    (file) => `${item.paths.worktree}/${file}`,
  );
  if (files.length === 0) {
    return "(none configured)";
  }
  return files.join(", ");
}

// The wiki's dir that practices pages are named under, as in "wiki/Decisions.md".
function practicesWikiDir(cfg: PracticesConfig): string {
  const { wiki } = cfg;
  if (typeof wiki === "object" && wiki !== null && wiki.dir !== undefined) {
    return wiki.dir;
  }
  return DEFAULT_WIKI_DIR;
}

// Where practices file `file` is: under the worktree, or, for a page under
// the wiki's dir, in the issue's wiki checkout, which in a stage job sits
// beside the code checkout rather than in it.
function practicePath(
  cfg: PracticesConfig,
  item: PromptItem,
  file: string,
): string {
  const { worktree, wiki } = item.paths;
  const prefix = `${practicesWikiDir(cfg)}/`;
  if (typeof wiki === "string" && wiki !== "" && file.startsWith(prefix)) {
    return `${wiki}/${file.slice(prefix.length)}`;
  }
  return `${worktree}/${file}`;
}

// The spec writer's note when the practices have a digest (config
// `practicesDigest`, spec-practices-digest): it reads the digest in full and
// opens a full file only for a rule that bears on its work, or reads them all
// when the digest is missing, and keeps the digest in step when its wiki
// updates change a practice.
function digestNote(
  cfg: PracticesConfig,
  item: PromptItem,
  digest: string,
): string {
  const files = (cfg.practices ?? []).map((file) =>
    practicePath(cfg, item, file),
  );
  let list = files.join(", ");
  if (files.length === 0) {
    list = "(none configured)";
  }
  return [
    `Coding practices: before the code, read their digest in full: ${practicePath(cfg, item, digest)}. It summarises these files, which win where they differ: ${list}. Open one of them, or a contributor rule it points to, only for a rule that bears on your work. If the digest doesn't exist, read each of those files in full instead, skipping any that don't exist, and any contributor rules they point to. The practices apply to all of the repo's code, not only the part the issue names.`,
    "If your wiki updates change a practice the digest covers, update the digest in the same wiki commit.",
    PRACTICES_USE.spec,
  ].join("\n");
}

// The note that tells a role to read the coding practices in full, and what
// to do with them; the spec writer reads their digest instead, when the
// config names one.
function practicesNote(
  cfg: PracticesConfig,
  item: PromptItem,
  use: PracticesUse = "spec",
): string {
  const digest = cfg.practicesDigest;
  if (use === "spec" && typeof digest === "string" && digest !== "") {
    return digestNote(cfg, item, digest);
  }
  return [
    `Coding practices: before the code, read each of these in full, skipping any that don't exist: ${practicesList(cfg, item)}. Also read any contributor rules they point to. They apply to all of the repo's code, not only the part the issue names.`,
    PRACTICES_USE[use],
  ].join("\n");
}

export { practicesNote };
