// GitHub transport and recovery journal for both coordination scopes, and the
// mutation hook that fences a bound job's or ops request's credentialed
// writes with it (controlledMutation). It is not a scheduler.
import { z } from "zod";
import { assertGranted } from "./assignment/grant.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, listRepoComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import type {
  CoordinationPort,
  Evidence,
  InvocationBinding,
} from "./coordination.ts";
import { coordination } from "./coordination.ts";
import {
  assertReconciled,
  confirmedWrite,
  writing,
} from "./coordination-journal.ts";
import { INVOCATION_BINDING, scopeOf } from "./coordination-records.ts";
import { gh, ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import type { RunResult } from "./process.ts";
import type { WriteIntent } from "./write-refusal.ts";
import { refusedWrite } from "./write-refusal.ts";

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const REF = z.object({ object: z.object({ sha: SHA }) });
const COMMIT = z.object({ sha: SHA, tree: z.object({ sha: SHA }) });
const NOT_FOUND = /HTTP 404/u;
function readRef(cfg: Config, ref: string): string | null {
  const result = gh(cfg, "merge", ["api", `repos/${cfg.repo}/git/ref/${ref}`], {
    allowFail: true,
  });
  if (result.code !== 0) {
    if (NOT_FOUND.test(result.stderr)) {
      return null;
    }
    throw new OpsError("coordination ref unreadable; reconciliation required");
  }
  return REF.parse(JSON.parse(result.stdout)).object.sha;
}
function tokenFor(cfg: Config, identity: InvocationBinding): string {
  const base = readRef(cfg, `heads/${cfg.baseBranch}`);
  if (base === null) {
    throw new OpsError(
      "configured base is missing; cannot establish coordination",
    );
  }
  const parent = COMMIT.parse(
    ghJson(cfg, "merge", ["api", `repos/${cfg.repo}/git/commits/${base}`]),
  );
  const created = COMMIT.parse(
    ghJson(
      cfg,
      "merge",
      ["api", "-X", "POST", `repos/${cfg.repo}/git/commits`, "--input", "-"],
      {
        input: JSON.stringify({
          message: `Pipeline coordination ${identity.instance} ${crypto.randomUUID()}`,
          tree: parent.tree.sha,
          parents: [parent.sha],
        }),
      },
    ),
  );
  return created.sha;
}
function portOf(
  cfg: Config,
  issue: number,
  repository: boolean,
): CoordinationPort {
  const { execution: _execution, mutation: _mutation, ...transport } = cfg;
  return {
    comments: (): readonly IssueComment[] => {
      assertReconciled(cfg, issue);
      if (repository) {
        guardExecution(cfg, issue);
        return listRepoComments(cfg, null);
      }
      return listComments(cfg, issue);
    },
    append: (body: string): void => rawComment(transport, issue, body),
    token: (identity: InvocationBinding): string =>
      tokenFor(transport, identity),
    lock: (ref: string): string | null => readRef(cfg, ref),
    reserve: (ref: string, token: string): void => {
      gh(
        transport,
        "merge",
        ["api", "-X", "POST", `repos/${cfg.repo}/git/refs`, "--input", "-"],
        { input: JSON.stringify({ ref: `refs/${ref}`, sha: token }) },
      );
    },
    write: (
      operation: string,
      write: () => void,
      confirmed: () => boolean,
      evidence?: Evidence,
    ): void =>
      confirmedWrite(cfg, issue, operation, {
        write,
        confirmed,
        evidence: evidence ?? null,
      }),
  };
}
// New invocations get a fresh identity even when their stable lane is shared.
// This does not acquire either scope or activate a runtime caller.
function executionBinding(
  cfg: Config,
  issue: number,
  lane: string,
): InvocationBinding {
  return INVOCATION_BINDING.parse({
    instance: crypto.randomUUID(),
    lane,
    issue,
    branch: paths.branch(cfg, issue),
    repo: cfg.repo,
    base: cfg.baseBranch,
  });
}
function bindingOf(cfg: Config, issue: number): InvocationBinding {
  const identity = INVOCATION_BINDING.parse(cfg.execution);
  if (
    identity.issue !== issue ||
    identity.branch !== paths.branch(cfg, issue) ||
    identity.repo !== cfg.repo ||
    identity.base !== cfg.baseBranch
  ) {
    throw new OpsError(
      "execution binding changed; explicit reconciliation required",
    );
  }
  return identity;
}
function issueExecution(
  cfg: Config,
  issue: number,
): ReturnType<typeof coordination> {
  const identity = bindingOf(cfg, issue);
  return coordination(
    cfg,
    portOf(cfg, issue, false),
    scopeOf(identity, "issue"),
    identity,
  );
}
function integrationTurn(
  cfg: Config,
  issue: number,
): ReturnType<typeof coordination> {
  // Issue execution remains an additional restriction, never replaced by a turn.
  assertExecution(cfg, issue);
  const identity = bindingOf(cfg, issue);
  return coordination(
    cfg,
    portOf(cfg, issue, true),
    scopeOf(identity, "integration"),
    identity,
  );
}
function assertExecution(cfg: Config, issue: number): void {
  assertReconciled(cfg, issue);
  issueExecution(cfg, issue).assertOwner();
}
// Callers without an execution, such as the coordination transport itself,
// are fenced by the ops envelope (ops/execution-envelope.ts) or not at all.
function guardExecution(cfg: Config, issue: number): void {
  if (cfg.execution !== undefined) {
    assertReconciled(cfg, issue);
    issueExecution(cfg, issue).assertOwner();
  }
}

// Each credentialed write of a bound job or ops request: a fresh ownership
// read, for a job started for an assignment a fresh grant read (#119), then
// the write journaled with its exact intent (#169). A write inside
// another journaled write runs under that one's journal, and one whose own
// operation reconciles it by reading isn't journaled again.
function controlledMutation(
  cfg: Config,
  write: () => RunResult,
  intent: WriteIntent,
): RunResult {
  const { execution } = cfg;
  if (execution === undefined) {
    return write();
  }
  guardExecution(cfg, execution.issue);
  if (cfg.grant !== undefined) {
    assertGranted(cfg, execution.issue, cfg.grant.login);
  }
  if (!intent.journal || writing(cfg, execution.issue)) {
    return write();
  }
  let result: RunResult | undefined;
  confirmedWrite(cfg, execution.issue, "controlled mutation", {
    write: (): void => {
      result = write();
    },
    confirmed: (): boolean => result?.code === 0,
    refused: (): boolean =>
      result !== undefined && refusedWrite(intent, result),
    evidence: { command: intent.command, args: [...intent.args] },
  });
  if (result === undefined) {
    throw new OpsError("controlled mutation response unavailable");
  }
  return result;
}

function withExecution(
  cfg: Config,
  identity: NonNullable<Config["execution"]>,
): Config {
  const validated = bindingOf({ ...cfg, execution: identity }, identity.issue);
  const bound: Config = {
    ...cfg,
    execution: validated,
    mutation: (write: () => RunResult, intent: WriteIntent): RunResult =>
      controlledMutation(bound, write, intent),
  };
  return bound;
}

export {
  assertExecution,
  executionBinding,
  guardExecution,
  integrationTurn,
  issueExecution,
  withExecution,
};
