// The wiki's link rules: which links in a wiki change point to no page, and
// which new pages nothing links to. A page is a `.md` file named by its base
// name, a link is `[[Page]]`, `[[text|Page]]` or a Markdown link to a bare page
// name, and code is never a link. Names match with spaces and dashes treated
// as one character, and case must match.

import type { Config } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { run } from "./process.ts";
import { wikiAhead } from "./wiki.ts";

// A wiki branch's pages and what it changed. `pages` maps each page's file
// path to its contents; `changed` lists the added or modified pages' paths and
// `added` the new ones, a subset of `changed`.
interface WikiChange {
  pages: ReadonlyMap<string, string>;
  changed: readonly string[];
  added: readonly string[];
}

type WikiProblem =
  | { kind: "broken-link"; page: string; target: string }
  | { kind: "orphan"; page: string };

const FENCE_LINE = /^ {0,3}(?<fence>`{3,}|~{3,})/u;
const CODE_SPAN = /(?<ticks>`+)(?!`)[\s\S]*?(?<!`)\k<ticks>(?!`)/gu;
const WIKI_LINK = /\[\[(?<inner>[^\]\n]+)\]\]/gu;
const MARKDOWN_LINK =
  /(?<!!)\[(?<text>[^\]\n]*)\]\((?<target>[^)\s]*)(?:\s+"[^"\n]*")?\)/gu;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const LEADING_DOT_SLASH = /^\.\//u;
const ANCHOR = /#.*$/u;
const MD_EXTENSION = /\.md$/u;
const OTHER_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/u;
const SPACES = / /gu;
const HOME = "Home";
const SPECIAL_PREFIX = "_";

// A page file's name: its base name without `.md`.
function pageName(file: string): string {
  const base = file.split("/").at(-1) ?? file;
  return base.replace(MD_EXTENSION, "");
}

// The form two names are compared in: spaces and dashes are one character.
function nameKey(name: string): string {
  return name.replace(SPACES, "-");
}

// The text with fenced code blocks and inline code spans blanked out.
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const { fence: marker } = FENCE_LINE.exec(line)?.groups ?? {};
    if (fence === null && marker !== undefined) {
      fence = marker;
    } else if (fence === null) {
      kept.push(line);
    } else if (marker?.startsWith(fence) === true) {
      fence = null;
    }
  }
  return kept.join("\n").replace(CODE_SPAN, " ");
}

// The page name a Markdown link's target names, or null when it names
// something else: an anchor, a path, a URL or a file that isn't a page.
function markdownTarget(raw: string): string | null {
  const target = raw
    .replace(LEADING_DOT_SLASH, "")
    .replace(ANCHOR, "")
    .replace(MD_EXTENSION, "");
  if (
    target === "" ||
    target.includes("/") ||
    URL_SCHEME.test(target) ||
    OTHER_EXTENSION.test(target)
  ) {
    return null;
  }
  return target;
}

// The distinct page names a page's text links to, in order of appearance.
function pageLinks(text: string): string[] {
  const prose = withoutCode(text);
  const links = new Set<string>();
  for (const match of prose.matchAll(WIKI_LINK)) {
    const { inner = "" } = match.groups ?? {};
    const target = inner.split("|").at(-1)?.trim() ?? "";
    if (target !== "") {
      links.add(target);
    }
  }
  for (const match of prose.matchAll(MARKDOWN_LINK)) {
    const { target: raw = "" } = match.groups ?? {};
    const target = markdownTarget(raw);
    if (target !== null) {
      links.add(target);
    }
  }
  return [...links];
}

function brokenLinks(
  change: WikiChange,
  names: ReadonlySet<string>,
): WikiProblem[] {
  const problems: WikiProblem[] = [];
  for (const file of change.changed) {
    const page = pageName(file);
    for (const target of pageLinks(change.pages.get(file) ?? "")) {
      if (!names.has(nameKey(target))) {
        problems.push({ kind: "broken-link", page, target });
      }
    }
  }
  return problems;
}

function orphans(change: WikiChange): WikiProblem[] {
  const linked = new Set<string>();
  for (const [file, text] of change.pages) {
    const own = nameKey(pageName(file));
    for (const target of pageLinks(text)) {
      const key = nameKey(target);
      if (key !== own) {
        linked.add(key);
      }
    }
  }
  const problems: WikiProblem[] = [];
  for (const file of change.added) {
    const page = pageName(file);
    const exempt = page === HOME || page.startsWith(SPECIAL_PREFIX);
    if (!(exempt || linked.has(nameKey(page)))) {
      problems.push({ kind: "orphan", page });
    }
  }
  return problems;
}

// Every problem in a wiki change: each distinct link in a changed page that
// names no page on the branch, then each new page, other than Home and the
// `_` pages, that no other page links to. Empty when the change is clean.
function wikiProblems(change: WikiChange): WikiProblem[] {
  const names = new Set(
    [...change.pages.keys()].map((file) => nameKey(pageName(file))),
  );
  return [...brokenLinks(change, names), ...orphans(change)];
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// `git diff --name-status -z` output as [status, file] pairs.
function statusPairs(output: string): [string, string][] {
  const fields = output.split("\0");
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    pairs.push([fields[i] ?? "", fields[i + 1] ?? ""]);
  }
  return pairs;
}

// Issue n's wiki checkout as committed at HEAD, against the wiki's branch on
// origin, or null when there is nothing to check: no wiki, no checkout, or no
// commits ahead of the wiki. Uncommitted edits are ignored.
function readWikiChange(cfg: Config, n: number): WikiChange | null {
  const wiki = wikiCfg(cfg);
  if (wiki === null || wikiAhead(cfg, n) === 0) {
    return null;
  }
  const dir = paths.wiki(cfg, n);
  const range = `origin/${wiki.branch}...HEAD`;
  const diff = gitIn(dir, [
    "diff",
    "-z",
    "--name-status",
    "--no-renames",
    range,
  ]);
  const changed: string[] = [];
  const added: string[] = [];
  for (const [status, file] of statusPairs(diff)) {
    if (file.endsWith(".md") && ["A", "M", "T"].includes(status)) {
      changed.push(file);
      if (status === "A") {
        added.push(file);
      }
    }
  }
  const files = gitIn(dir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
    .split("\0")
    .filter((file) => file.endsWith(".md"));
  const pages = new Map(
    files.map((file) => [file, gitIn(dir, ["show", `HEAD:${file}`])]),
  );
  return { added, changed, pages };
}

export type { WikiChange, WikiProblem };
export { readWikiChange, wikiProblems };
