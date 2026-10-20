import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { head } from "../git-state.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { assertExecution } from "./authority.ts";
import { lockHead } from "./exclusion.ts";
import { hubOf } from "./github.ts";
import { emptyCoordination } from "./schema.ts";

function beginMutation(
  cfg: Config,
  issue: number,
  kind: string,
  expected: string | null = null,
): void {
  if (cfg.assignment === undefined) {
    return;
  }
  assertExecution(cfg, issue);
  const state = readWriteState(cfg, issue);
  const coordination = state.coordination ?? emptyCoordination();
  if (coordination.pending !== null) {
    throw new OpsError(
      `uncertain ${coordination.pending.kind}; explicit reconciliation required, not a retry`,
    );
  }
  const pending = { kind, expected, at: new Date().toISOString() };
  writeState(cfg, issue, {
    ...state,
    coordination: { ...coordination, pending },
  });
  const confirmed = readWriteState(cfg, issue).coordination?.pending;
  if (confirmed?.kind !== kind || confirmed.at !== pending.at) {
    throw new OpsError("mutation intent save could not be confirmed");
  }
}
function finishMutation(cfg: Config, issue: number, kind: string): void {
  if (cfg.assignment === undefined) {
    return;
  }
  const state = readWriteState(cfg, issue);
  if (state.coordination?.pending?.kind !== kind) {
    throw new OpsError("mutation intent changed; reconcile before continuing");
  }
  writeState(cfg, issue, {
    ...state,
    coordination: { ...state.coordination, pending: null },
  });
}

// Only an exact remote observation confirms a push. Local commits, the
// optimistic pre-push log and an arbitrary current branch tip grant no
// recoverable checkpoint. A crash leaves the intent and exclusive ref held.
function confirmedPush(
  cfg: Config,
  issue: number,
  repo: "code" | "wiki",
  push: () => void,
): void {
  if (cfg.assignment === undefined) {
    push();
    return;
  }
  let dir = paths.worktree(cfg, issue);
  if (repo === "wiki") {
    dir = paths.wiki(cfg, issue);
  }
  const expected = head(dir);
  const kind = `${repo}-push`;
  beginMutation(cfg, issue, kind, expected);
  push();
  const branch = paths.branch(cfg, issue);
  assertPublishedHead(cfg, { dir, branch }, expected);
  const state = readWriteState(cfg, issue);
  const coordination = state.coordination ?? emptyCoordination();
  const previous = coordination.checkpoint;
  const checkpoint = {
    branch,
    code: previous?.code ?? null,
    wiki: previous?.wiki ?? null,
    pr: state.pr,
    inputs: state.gherkin?.inputs ?? "pre-author",
    at: new Date().toISOString(),
  };
  let { headSha } = state;
  if (repo === "code") {
    checkpoint.code = expected;
    headSha = expected;
  } else {
    checkpoint.wiki = expected;
  }
  if (
    coordination.pending?.kind !== kind ||
    coordination.pending.expected !== expected
  ) {
    throw new OpsError("push intent changed");
  }
  writeState(cfg, issue, {
    ...state,
    headSha,
    coordination: { ...coordination, pending: null, checkpoint },
  });
}

function assertPublishedHead(
  cfg: Config,
  location: { dir: string; branch: string },
  expected: string,
): void {
  const [observed] = git(cfg, "dev", [
    "-C",
    location.dir,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${location.branch}`,
  ])
    .stdout.trim()
    .split("\t");
  if (observed !== expected) {
    throw new OpsError(
      "checkpoint not confirmed remotely; local recovery required",
    );
  }
}

function verifyCheckpoint(cfg: Config, state: IssueState): void {
  const checkpoint = state.coordination?.checkpoint;
  if (
    checkpoint === undefined ||
    checkpoint === null ||
    state.stage === "done"
  ) {
    return;
  }
  if (checkpoint.branch !== state.branch) {
    throw new OpsError("checkpoint branch binding changed");
  }
  if (
    checkpoint.code !== null &&
    state.codeMerged === null &&
    lockHead(hubOf(cfg), `heads/${checkpoint.branch}`) !== checkpoint.code
  ) {
    throw new OpsError(
      "source checkpoint moved or missing; do not invent a recoverable head",
    );
  }
  if (checkpoint.wiki !== null) {
    if (wikiCfg(cfg) === null) {
      throw new OpsError("wiki checkpoint outside configured scope");
    }
    const remote = `https://github.com/${cfg.repo}.wiki.git`;
    const [observed] = git(cfg, "dev", [
      "ls-remote",
      "--heads",
      remote,
      `refs/heads/${checkpoint.branch}`,
    ])
      .stdout.trim()
      .split("\t");
    if (observed !== checkpoint.wiki) {
      throw new OpsError(
        "private wiki checkpoint moved or missing; explicit recovery required",
      );
    }
  }
}

export {
  assertPublishedHead,
  beginMutation,
  confirmedPush,
  finishMutation,
  verifyCheckpoint,
};
