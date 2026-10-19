// Adoption never cleans or rewrites a retained checkout. Immutable bundles and
// independent index/worktree patches retain even work that cannot be adopted.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AdoptionRequest } from "./adoption-plan.ts";
import type { Config } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { saveBundle } from "./job/code-recovery.ts";
import { saveDroppedPatch } from "./job/dropped-patch.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";

const FILE = z.object({ file: z.string(), sha256: z.string() });
const TREE = z.object({
  dir: z.string(),
  kind: z.enum(["code", "wiki"]),
  head: z.string(),
  refs: z.string(),
  origin: z.string(),
  branch: z.string(),
  unpushed: z.string(),
  patches: z.array(FILE),
  bundle: FILE,
});
const PRESERVATION = z.object({
  trees: z.array(TREE),
  handoffs: z.array(FILE),
});
type Preservation = z.infer<typeof PRESERVATION>;

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidenceFile(file: string): z.infer<typeof FILE> {
  return { file, sha256: digest(fs.readFileSync(file)) };
}

function gitText(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout.trim();
}

function exists(dir: string): boolean {
  return fs.statSync(dir, { throwIfNoEntry: false }) !== undefined;
}

// Includes every retained job for this issue, the old lane, shared refs and
// explicitly selected external work. No other issue's checkout is touched.
function retainedTrees(
  cfg: Config,
  issue: number,
  code: string,
  wiki: string | undefined,
): { dir: string; kind: "code" | "wiki" }[] {
  const codeDirs = [
    code,
    paths.worktree(cfg, issue),
    paths.clone(cfg),
    paths.mirror(cfg),
  ];
  const jobs = path.dirname(paths.jobCheckout(cfg, issue, "author"));
  if (exists(jobs)) {
    for (const entry of fs.readdirSync(jobs).sort()) {
      if (entry.startsWith(`issue-${issue}-`)) {
        codeDirs.push(path.join(jobs, entry, "repo"));
      }
    }
  }
  const wikiDirs: string[] = [];
  const settings = wikiCfg(cfg);
  if (wiki !== undefined) {
    wikiDirs.push(wiki);
  }
  // Retained wiki work still matters when today's config disabled the wiki.
  // Preserve it, then refuse the unresolved identity rather than losing it.
  wikiDirs.push(paths.wikiMirror(cfg));
  for (const dir of codeDirs) {
    wikiDirs.push(path.join(dir, settings?.dir ?? "wiki"));
    if (path.basename(dir) === "repo") {
      wikiDirs.push(path.join(path.dirname(dir), "docs"));
    }
  }
  return [
    ...existingTrees(codeDirs, "code"),
    ...existingTrees(wikiDirs, "wiki"),
  ]
    .filter(
      (tree, index, all) =>
        all.findIndex((other) => other.dir === tree.dir) === index,
    )
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

function existingTrees(
  dirs: string[],
  kind: "code" | "wiki",
): { dir: string; kind: "code" | "wiki" }[] {
  return dirs
    .filter(exists)
    .map((dir) => fs.realpathSync(dir))
    .filter(
      (dir) =>
        kind === "code" ||
        exists(path.join(dir, ".git")) ||
        exists(path.join(dir, "HEAD")),
    )
    .map((dir) => ({ dir, kind }));
}

function retainedHistory(dir: string): {
  head: string;
  refs: string;
  unpushed: string;
  bundleRefs: string[];
} {
  const head = gitText(dir, ["rev-parse", "--verify", "HEAD"]);
  let refs = gitText(dir, ["show-ref"]);
  const original = run(
    "git",
    ["-C", dir, "rev-parse", "--verify", "--quiet", "ORIG_HEAD"],
    { allowFail: true },
  );
  const bundleRefs = ["HEAD", "--all"];
  if (original.code === 0) {
    bundleRefs.push("ORIG_HEAD");
    refs += `\n${original.stdout.trim()} ORIG_HEAD`;
  } else if (original.code > 1) {
    throw new OpsError(`unreadable original head in ${dir}`);
  }
  const unpushed = gitText(dir, [
    "rev-list",
    ...bundleRefs,
    "--not",
    "--remotes=origin",
  ]);
  return { head, refs, unpushed, bundleRefs };
}

function preserveTree(
  cfg: Config,
  tree: { dir: string; kind: "code" | "wiki" },
  dest: string,
): z.infer<typeof TREE> {
  fs.mkdirSync(dest);
  const { dir, kind } = tree;
  const { head, refs, unpushed, bundleRefs } = retainedHistory(dir);
  const origin = gitText(dir, ["remote", "get-url", "origin"]);
  const symbolic = run(
    "git",
    ["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { allowFail: true },
  );
  if (symbolic.code > 1) {
    throw new OpsError(`unreadable branch in ${dir}`);
  }
  const branch = symbolic.stdout.trim();
  const bare = gitText(dir, ["rev-parse", "--is-bare-repository"]) === "true";
  const patches: z.infer<typeof FILE>[] = [];
  if (!bare) {
    const prepared = saveDroppedPatch(cfg, dir, {
      file: path.join(dest, "working.patch"),
      title: "Retained adoption work",
    });
    patches.push(...prepared.files.map(evidenceFile));
  }
  const bundle = path.join(dest, "commits.bundle");
  saveBundle(dir, bundle, bundleRefs);
  return {
    dir,
    kind,
    head,
    refs,
    origin,
    branch,
    unpushed,
    patches,
    bundle: evidenceFile(bundle),
  };
}

function preserveWork(
  cfg: Config,
  request: AdoptionRequest,
  dest: string,
): Preservation {
  const { issue, code, wiki } = request;
  const trees = retainedTrees(cfg, issue, code, wiki).map((tree, index) =>
    preserveTree(cfg, tree, path.join(dest, `tree-${index}`)),
  );
  const handoffs = preserveHandoffs(paths.runDir(cfg, issue), dest);
  return { trees, handoffs };
}

function copyHandoffs(source: string, dest: string): z.infer<typeof FILE>[] {
  const info = fs.lstatSync(source);
  if (info.isDirectory()) {
    return fs
      .readdirSync(source)
      .sort()
      .flatMap((name) =>
        copyHandoffs(path.join(source, name), path.join(dest, name)),
      );
  }
  if (!info.isFile()) {
    throw new OpsError(
      `unreadable handoff/recovery evidence ${source}; retain it for recovery`,
    );
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
  return [evidenceFile(dest)];
}

function preserveHandoffs(
  runDir: string,
  dest: string,
): z.infer<typeof FILE>[] {
  return fs
    .readdirSync(runDir)
    .sort()
    .filter(
      (name) =>
        name.includes("handoff") ||
        [
          "issue.md",
          "job.json",
          "job.log",
          "sessions",
          "recovery",
          "dropped",
        ].includes(name),
    )
    .flatMap((name) =>
      copyHandoffs(path.join(runDir, name), path.join(dest, "handoffs", name)),
    );
}

function verifyEvidence(saved: Preservation): void {
  for (const tree of saved.trees) {
    for (const file of [tree.bundle, ...tree.patches]) {
      if (evidenceFile(file.file).sha256 !== file.sha256) {
        throw new OpsError(`changed recovery evidence ${file.file}`);
      }
    }
    run("git", ["-C", tree.dir, "bundle", "verify", tree.bundle.file]);
    const bundled = new Set(
      gitText(tree.dir, ["bundle", "list-heads", tree.bundle.file]).split("\n"),
    );
    if (
      [`${tree.head} HEAD`, ...tree.refs.split("\n")].some(
        (ref) => !bundled.has(ref),
      )
    ) {
      throw new OpsError(
        `bundle does not retain inventoried heads in ${tree.dir}`,
      );
    }
  }
  for (const file of saved.handoffs) {
    if (evidenceFile(file.file).sha256 !== file.sha256) {
      throw new OpsError(`changed handoff evidence ${file.file}`);
    }
  }
}

function workIdentity(work: Preservation): string {
  return JSON.stringify({
    trees: work.trees.map(({ bundle: _bundle, patches, ...tree }) => ({
      ...tree,
      patches: patches.map(({ file, sha256 }) => ({
        name: path.basename(file),
        sha256,
      })),
    })),
    handoffs: work.handoffs.map(({ file, sha256 }) => ({
      name: path.basename(file),
      sha256,
    })),
  });
}

export type { Preservation };
export {
  digest,
  gitText,
  PRESERVATION,
  preserveWork,
  verifyEvidence,
  workIdentity,
};
