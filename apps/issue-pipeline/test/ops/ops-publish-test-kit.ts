// Shared setup for the merge and finish op tests, which call the ops'
// own functions. Before any src module loads it points the pipeline root and
// HOME at a temporary folder (and checks src took it), puts the fake gh first
// on PATH, and resolves src's ../revision.ts to
// fake-ops-publish-revision.ts. world() then builds issue #7's code
// worktree on agent/issue-7 one commit past origin's integration.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type {
  ResolveFnOutput,
  ResolveHookContext,
  ResolveHookSync,
} from "node:module";
import { registerHooks } from "node:module";
import path from "node:path";
import type { Config } from "../../src/config.ts";
import type { PrView } from "../../src/ops/pr-merge.ts";
import type { IssueState, Revision, Security } from "../../src/state.ts";
import { credentialConfig } from "../credentials-test-kit.ts";
import type { GhReply } from "../fake-gh.ts";
import { claimComment, githubComment, installFakeGh } from "../fake-gh.ts";
import { home, root } from "./ops-publish-environment-fixtures.ts";

interface World {
  cfg: Config;
  root: string;
  sha: string;
  mergeSha: string;
  worktree: string;
}

const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CLAIM_ID = 501;
const ACCOUNT = "bot";
const REPO = "o/r";
const ISSUE = 7;
const PR = 50;
const MERGE_COMMIT = "4e1d0c0ffee0000000000000000000000000beef";
const SECURITY_COMMENT = 901;
const GIT_USER = "-c user.email=a@b -c user.name=a";

const fakeGh = installFakeGh();
fakeGh.requireReplies();

const SRC: string = new URL("../../src/", import.meta.url).href;
const DOUBLE: string = new URL(
  "./fake-ops-publish-revision.ts",
  import.meta.url,
).href;
registerHooks({
  resolve(
    specifier: string,
    context: ResolveHookContext,
    nextResolve: Parameters<ResolveHookSync>[2],
  ): ResolveFnOutput {
    if (
      specifier === "../revision.ts" &&
      (context.parentURL ?? "").startsWith(SRC)
    ) {
      return { url: DOUBLE, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const pipelineRoot: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== home) {
  throw new Error("src took a pipeline root outside the test's folder");
}
const { loadConfig }: typeof import("../../src/config.ts") = await import(
  "../../src/config.ts"
);
const { ghIsRead }: typeof import("../../src/github.ts") = await import(
  "../../src/github.ts"
);
const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);

function sh(command: string): string {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// A fresh world in the shared root: origin, the clone and #7's worktree.
function world(): World {
  for (const entry of fs.readdirSync(root)) {
    if (entry !== "home") {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
  const config = path.join(root, "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      repo: REPO,
      ...credentialConfig(ACCOUNT),
      allowedUsers: ["alice"],
      commands: { test: "true" },
      baseBranch: "integration",
    }),
  );
  const worktree = path.join(root, "work/o__r/issue-7");
  const clone = path.join(root, "clones/o__r");
  sh(
    `cd ${root} && git init -q --bare -b integration origin.git && git clone -q origin.git seed 2>/dev/null && cd seed && git ${GIT_USER} commit -q --allow-empty -m base && git push -q origin HEAD:integration`,
  );
  sh(
    `git clone -q ${root}/origin.git ${clone} && git -C ${clone} worktree add -q -b agent/issue-7 ${worktree} origin/integration && echo first > ${worktree}/first.txt && git -C ${worktree} add first.txt && git -C ${worktree} ${GIT_USER} commit -q -m first && echo second > ${worktree}/second.txt && git -C ${worktree} add second.txt && git -C ${worktree} ${GIT_USER} commit -q -m second`,
  );
  const sha = sh(`git -C ${worktree} rev-parse HEAD`);
  sh(`git -C ${worktree} push -q origin HEAD:agent/issue-7`);
  const tree = sh(`git -C ${worktree} rev-parse HEAD^{tree}`);
  const mergeSha = sh(
    `git -C ${worktree} ${GIT_USER} commit-tree ${tree} -p origin/integration -p ${sha} -m merged`,
  );
  sh(`git -C ${worktree} push -q origin ${mergeSha}:refs/fixture/result`);
  return { cfg: loadConfig(config), root, sha, mergeSha, worktree };
}

// Issue #7's state at merge: PR #50, hardened (and approved, as a legacy
// review) at `approved`, with `extra`.
function approvedState(approved: Revision, extra: object = {}): IssueState {
  return {
    ...newIssueState(ISSUE),
    stage: "merge",
    pr: PR,
    flows: { code: true },
    review: {
      round: 0,
      verdict: "approve",
      commentId: null,
      findings: [],
      revision: approved,
    },
    hardened: approved,
    hardenedTarget: { repo: REPO, branch: "integration", sha: TARGET_SHA },
    verifiedSha: approved.code,
    security: {
      ...securityOf(approved),
      phase: "candidate",
      target: { repo: REPO, branch: "integration", sha: TARGET_SHA },
    },
    ...extra,
  };
}

function boundState(
  w: World,
  approved: Revision,
  extra: object = {},
): IssueState {
  const sha = sh(`git -C ${w.worktree} rev-parse origin/integration`);
  return approvedState(approved, {
    hardenedTarget: { repo: w.cfg.repo, branch: w.cfg.baseBranch, sha },
    security: {
      ...securityOf(approved),
      phase: "candidate",
      target: { repo: w.cfg.repo, branch: w.cfg.baseBranch, sha },
    },
    ...extra,
  });
}

// A security review of the merged result `result` that found nothing, or
// `finding` when given.
function securityOf(
  result: Revision,
  finding: Security["finding"] = null,
): Security {
  return { revision: result, commentId: SECURITY_COMMENT, finding };
}

// gh's answer to listing #7's comments, every time: the pipeline's state
// comment holding `state` and, when `claim` is set, a live claim.
function savedListing(
  state: object,
  { claim = false }: { claim?: boolean } = {},
): GhReply {
  const at = new Date().toISOString();
  const items = [
    githubComment({
      id: 900,
      body: `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #7. The pipeline rewrites this comment; do not edit it.</sub>`,
      login: ACCOUNT,
      created: at,
    }),
  ];
  if (claim === true) {
    items.push(
      claimComment({
        id: CLAIM_ID,
        lane: "L",
        sweep: "s1",
        login: ACCOUNT,
        at,
      }),
    );
  }
  return {
    when: "issues/7/comments?per_page",
    stdout: items.map((item) => JSON.stringify(item)).join("\n"),
    keep: true,
  };
}

function prView(view: Partial<PrView>): GhReply {
  return {
    when: "pr view 50",
    keep: view.state === "MERGED",
    stdout: JSON.stringify({
      url: `https://github.com/${REPO}/pull/${PR}`,
      number: PR,
      isCrossRepository: false,
      headRefName: "agent/issue-7",
      baseRefName: "integration",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      mergeCommit: null,
      state: "OPEN",
      ...view,
    }),
  };
}

// The gh calls since the last reply() that change GitHub.
function writes(): string[][] {
  return fakeGh.writes(ghIsRead);
}

function mergeAuthority(state: IssueState): GhReply[] {
  return [
    { ...savedListing(state), persistState: true },
    { when: "api -X PATCH repos/o/r/issues/comments/900 -f", keep: true },
  ];
}

// Issue #7 hardened (and approved, as a legacy review) at `approved`, saved
// at stage review unless `extra` says otherwise.
function hardenedApproval(approved: Revision, extra: object = {}): IssueState {
  return approvedState(approved, {
    stage: "review",
    hardened: approved,
    ...extra,
  });
}

function readyView(view: object): GhReply {
  return {
    when: `pr view ${PR}`,
    stdout: JSON.stringify({
      number: PR,
      state: "OPEN",
      isDraft: true,
      headRefName: "agent/issue-7",
      isCrossRepository: false,
      baseRefName: "integration",
      ...view,
    }),
  };
}

export type { World };
export {
  approvedState,
  boundState,
  fakeGh,
  GIT_USER,
  hardenedApproval,
  ISSUE,
  MERGE_COMMIT,
  mergeAuthority,
  PR,
  prView,
  REPO,
  readyView,
  savedListing,
  securityOf,
  sh,
  world,
  writes,
};
