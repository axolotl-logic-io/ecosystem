// @ts-check
// Shared setup for the merge, publish and finish-wiki op tests, which call the
// ops' own functions. Before any src module loads it points the pipeline root
// and HOME at a temporary folder (and checks src took it), puts the fake gh
// first on PATH, and resolves src's ../revision.ts to
// ops-publish-revision-double.mjs. world() then builds issue #7's code
// worktree on agent/issue-7 one commit past origin's integration, and, with
// `wiki`, its wiki checkout one commit past the wiki origin's master.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { z } from "zod";
import { credentialConfig } from "./credentials-test-kit.mjs";
import { githubComment, installFakeGh } from "./fake-gh.mjs";
import { home, root } from "./ops-publish-environment.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @typedef {{ cfg: import("../src/config.ts").Config, root: string, sha: string, mergeSha: string, worktree: string, wikiDir: string, wikiOrigin: string, wikiSha: string | null }} World */

const ACCOUNT = "bot";
const REPO = "o/r";
const ISSUE = 7;
const PR = 50;
const MERGE_COMMIT = "4e1d0c0ffee0000000000000000000000000beef";
const SECURITY_COMMENT = 901;
const GIT_USER = "-c user.email=a@b -c user.name=a";

const fakeGh = installFakeGh();
fakeGh.requireReplies();

const SRC = new URL("../src/", import.meta.url).href;
const DOUBLE = new URL("./ops-publish-revision-double.mjs", import.meta.url)
  .href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../revision.ts" &&
      (context.parentURL ?? "").startsWith(SRC)
    ) {
      return { url: DOUBLE, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const pipelineRoot = await import("../src/pipeline-root.ts");
if (pipelineRoot.ROOT !== root || pipelineRoot.HOME !== home) {
  throw new Error("src took a pipeline root outside the test's folder");
}
const { loadConfig } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");
const { newIssueState } = await import("../src/state.ts");
const { publishOps } = await import("../src/ops/publish.ts");
// The publish op's reply: the wiki's new head and the commits it added, or
// why it refused. Strict, so a reply with fields neither names fails.
const PUBLISH_REPLY = z.discriminatedUnion("published", [
  z.strictObject({
    published: z.literal(true),
    sha: z.string().nullable(),
    commits: z.array(z.string()),
    alreadyPublished: z.boolean(),
  }),
  z.strictObject({
    published: z.literal(false),
    reason: z.string(),
    detail: z.string(),
  }),
]);

/** @param {string} command @returns {string} */
function sh(command) {
  const r = spawnSync("bash", ["-c", command], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${command}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// A fresh world in the shared root: origin, the clone, #7's worktree and,
// with `wiki`, the wiki origin, its clone and #7's wiki checkout.
/** @param {{ wiki?: boolean }} [options] @returns {World} */
function world({ wiki = false } = {}) {
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
      wiki,
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
  const wikiOrigin = path.join(root, "wiki.git");
  const wikiDir = path.join(worktree, "wiki");
  let wikiSha = null;
  if (wiki) {
    const wikiClone = path.join(root, "clones/o__r.wiki");
    sh(
      `cd ${root} && git init -q --bare -b master wiki.git && git clone -q wiki.git ${wikiClone} 2>/dev/null && echo home > ${wikiClone}/Home.md && git -C ${wikiClone} add Home.md && git -C ${wikiClone} ${GIT_USER} commit -q -m home && git -C ${wikiClone} push -q origin HEAD:master`,
    );
    sh(
      `git -C ${wikiClone} worktree add -q -b agent/issue-7 ${wikiDir} origin/master && echo issue > ${wikiDir}/Home.md && git -C ${wikiDir} ${GIT_USER} commit -q -am page && git -C ${wikiDir} push -q origin HEAD:agent/issue-7`,
    );
    wikiSha = sh(`git -C ${wikiDir} rev-parse HEAD`);
  }
  return {
    cfg: loadConfig(config),
    root,
    sha,
    mergeSha,
    worktree,
    wikiDir,
    wikiOrigin,
    wikiSha,
  };
}

// The wiki origin's master gains a commit of someone else's.
/** @param {World} w @returns {string} */
function moveWiki(w) {
  const other = path.join(root, "wiki-other");
  sh(
    `git clone -q ${w.wikiOrigin} ${other} 2>/dev/null && echo other > ${other}/Other.md && git -C ${other} add Other.md && git -C ${other} ${GIT_USER} commit -q -m other && git -C ${other} push -q origin HEAD:master`,
  );
  return sh(`git -C ${w.wikiOrigin} rev-parse master`);
}

/** @param {World} w @param {string} ref @returns {string} */
function wikiRef(w, ref) {
  return sh(`git -C ${w.wikiOrigin} rev-parse --verify --quiet ${ref} || true`);
}

/**
 * Issue #7's state at merge: PR #50, hardened (and approved, as a legacy
 * review) at `approved`, with `extra`.
 * @param {{ code: string | null, wiki: string | null, inputs: string }} approved
 * @param {object} [extra]
 * @returns {import("../src/state.ts").IssueState}
 */
function approvedState(approved, extra = {}) {
  return {
    ...newIssueState(ISSUE),
    stage: "merge",
    pr: PR,
    flows: { code: true, wiki: approved.wiki !== null },
    review: {
      round: 0,
      verdict: "approve",
      commentId: null,
      findings: [],
      revision: approved,
    },
    hardened: approved,
    ...extra,
  };
}

// A security review of the merged result `result` that found nothing, or
// `finding` when given.
/**
 * @param {import("../src/state.ts").Revision} result
 * @param {import("../src/state.ts").Security["finding"]} [finding]
 * @returns {import("../src/state.ts").Security}
 */
function securityOf(result, finding = null) {
  return { revision: result, commentId: SECURITY_COMMENT, finding };
}

// gh's answer to listing #7's comments, every time: the pipeline's state
// comment holding `state` and, when `claim` is set, a live claim.
/** @param {object} state @param {{ claim?: boolean }} [options] @returns {GhReply} */
function savedListing(state, { claim = false } = {}) {
  const at = new Date().toISOString();
  const items = [
    githubComment({
      id: 900,
      body: `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->\n<sub>Machine state for #7. The pipeline rewrites this comment; do not edit it.</sub>`,
      login: ACCOUNT,
      created: at,
    }),
  ];
  if (claim) {
    items.push(
      githubComment({
        id: 501,
        body: "<!-- agent-pipeline:comment role=claim -->\nLane `L` is claiming this issue.\n<!-- agent-pipeline:claim lane=L sweep=s1 -->",
        login: ACCOUNT,
        created: at,
        updated: at,
      }),
    );
  }
  return {
    when: "issues/7/comments?per_page",
    stdout: items.map((item) => JSON.stringify(item)).join("\n"),
    keep: true,
  };
}

/** @param {Partial<import("../src/ops/pr-merge.ts").PrView>} view @returns {GhReply} */
function prView(view) {
  return {
    when: "pr view 50",
    keep: view.state === "MERGED",
    stdout: JSON.stringify({
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
/** @returns {string[][]} */
function writes() {
  return fakeGh.writes(ghIsRead);
}

// Runs the publish op as the merge role asks it, its reply checked against
// the publish reply's shape.
/** @param {import("../src/config.ts").Config} cfg @param {object} request @returns {z.infer<typeof PUBLISH_REPLY>} */
function publishOf(cfg, request) {
  const { publish } = publishOps;
  if (publish === undefined) {
    throw new Error("publish is not an op");
  }
  return PUBLISH_REPLY.parse(publish(cfg, request));
}

// Why the publish op refused the request; a publish fails the test.
/** @param {import("../src/config.ts").Config} cfg @param {object} request @returns {string} */
function refusalOf(cfg, request) {
  const reply = publishOf(cfg, request);
  if (reply.published) {
    throw new Error("publish published what it should refuse");
  }
  return reply.reason;
}

export {
  approvedState,
  fakeGh,
  GIT_USER,
  ISSUE,
  MERGE_COMMIT,
  moveWiki,
  PR,
  prView,
  publishOf,
  REPO,
  refusalOf,
  savedListing,
  securityOf,
  sh,
  wikiRef,
  world,
  writes,
};
