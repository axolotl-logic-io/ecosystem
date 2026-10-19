// Only actual fetched merge ancestry, never legacy merge claims, closes code.
import fs from "node:fs";
import path from "node:path";
import { assertOrigin } from "./adoption-origin.ts";
import type { Plan } from "./adoption-plan.ts";
import { gitText } from "./adoption-preservation.ts";
import type { Config } from "./config.ts";
import { git } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";

function assertAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
  what: string,
): void {
  const result = run(
    "git",
    ["-C", repo, "merge-base", "--is-ancestor", ancestor, descendant],
    { allowFail: true },
  );
  if (result.code !== 0) {
    throw new OpsError(
      `${what} is not reconciled with preserved work; recover explicitly`,
    );
  }
}

function validateGraph(
  cfg: Config,
  plan: Pick<Plan, "request" | "truth" | "work">,
  dest: string,
): void {
  const { request, truth } = plan;
  validateRetainedOrigins(cfg, plan);
  const source = truth.head ?? truth.prHead;
  if (source !== null) {
    assertAncestor(request.code, source, "HEAD", "actual code head");
  }
  if (truth.merge !== null) {
    const repo = path.join(
      fs.mkdtempSync(path.join(dest, "merge-truth-")),
      "repository.git",
    );
    const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
    git(cfg, "dev", [
      "clone",
      url,
      repo,
      "--bare",
      "--single-branch",
      "--branch",
      cfg.baseBranch,
    ]);
    if (
      gitText(repo, ["rev-parse", `refs/heads/${cfg.baseBranch}`]) !==
      truth.baseHead
    ) {
      throw new OpsError(
        "configured target head changed during merge validation",
      );
    }
    assertAncestor(
      repo,
      truth.merge,
      `refs/heads/${cfg.baseBranch}`,
      "actual PR merge on configured target",
    );
  }
  validateWikiGraph(plan);
}

function validateWikiGraph(
  plan: Pick<Plan, "request" | "truth" | "work">,
): void {
  const { request, truth, work } = plan;
  if (truth.wiki !== null && request.wiki !== undefined) {
    for (const tree of work.trees.filter((item) => item.kind === "wiki")) {
      assertAncestor(request.wiki, tree.head, "HEAD", "retained wiki head");
      const privateRef = tree.refs
        .split("\n")
        .find((ref) => ref.endsWith(` refs/heads/${truth.branch}`));
      if (privateRef !== undefined) {
        const [privateHead] = privateRef.split(" ");
        if (privateHead !== undefined) {
          assertAncestor(
            request.wiki,
            privateHead,
            "HEAD",
            "retained private wiki branch",
          );
        }
      }
    }
    assertAncestor(
      request.wiki,
      truth.wiki.published,
      "HEAD",
      "published wiki head",
    );
    if (truth.wiki.privateHead !== null) {
      assertAncestor(
        request.wiki,
        truth.wiki.privateHead,
        "HEAD",
        "private wiki head",
      );
    }
  }
}

function validateRetainedOrigins(
  cfg: Config,
  plan: Pick<Plan, "truth" | "work">,
): void {
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  for (const tree of plan.work.trees) {
    let expected = url;
    if (tree.kind === "wiki") {
      if (plan.truth.wiki === null) {
        throw new OpsError("retained wiki has no reconciled identity");
      }
      expected = plan.truth.wiki.origin;
    }
    assertOrigin(tree.dir, expected);
  }
}

export { validateGraph };
