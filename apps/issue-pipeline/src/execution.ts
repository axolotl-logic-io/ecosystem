// GitHub transport and recovery journal for both coordination scopes. This is
// a protocol primitive, not a scheduler. Integration turns have no runtime
// caller until assignment-mode composition deliberately opts into this API.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueComment } from "./comments.ts";
import { listComments, listRepoComments, rawComment } from "./comments.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import type { CoordinationPort, Evidence, Identity } from "./coordination.ts";
import { coordination } from "./coordination.ts";
import { gh, ghJson } from "./github.ts";
import { OpsError } from "./ops-error.ts";
import type { RunResult } from "./process.ts";

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const REF = z.object({ object: z.object({ sha: SHA }) });
const COMMIT = z.object({ sha: SHA, tree: z.object({ sha: SHA }) });
const NOT_FOUND = /HTTP 404/u;
const activeWrites = new Set<string>();

function journalPath(cfg: Config, issue: number): string {
  return path.join(paths.runDir(cfg, issue), "coordination-uncertain.json");
}
function assertReconciled(cfg: Config, issue: number): void {
  if (
    !activeWrites.has(journalPath(cfg, issue)) &&
    fs.existsSync(journalPath(cfg, issue))
  ) {
    throw new OpsError(
      `uncertain coordination write retained at ${journalPath(cfg, issue)}; explicit reconciliation required`,
    );
  }
}
// Exactly one write attempt, including across subprocesses/restarts. A lost
// response is acceptable only when a fresh read proves the exact outcome.
function confirmedWrite(
  cfg: Config,
  issue: number,
  operation: string,
  attempt: { write: () => void; confirmed: () => boolean; evidence?: Evidence },
): void {
  const { write, confirmed } = attempt;
  assertReconciled(cfg, issue);
  const file = journalPath(cfg, issue);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      operation,
      evidence: attempt.evidence,
      instance: cfg.execution?.instance,
      at: new Date().toISOString(),
    }),
    { flag: "wx" },
  );
  activeWrites.add(file);
  try {
    try {
      write();
    } catch {
      // Read-back, not a successful transport response, establishes authority.
    }
    if (!confirmed()) {
      throw new OpsError(
        `uncertain ${operation}; preserve ${file} and reconcile without retrying`,
      );
    }
    fs.unlinkSync(file);
  } finally {
    activeWrites.delete(file);
  }
}
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
function tokenFor(cfg: Config, identity: Identity): string {
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
    token: (identity: Identity): string => tokenFor(transport, identity),
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
function identityOf(cfg: Config, issue: number): Identity {
  if (cfg.execution === undefined) {
    throw new OpsError("active execution identity required");
  }
  return { ...cfg.execution, issue, branch: paths.branch(cfg, issue) };
}
function issueExecution(
  cfg: Config,
  issue: number,
): ReturnType<typeof coordination> {
  return coordination(
    cfg,
    portOf(cfg, issue, false),
    JSON.stringify([cfg.repo, cfg.baseBranch, "issue", issue]),
    identityOf(cfg, issue),
  );
}
function integrationTurn(
  cfg: Config,
  issue: number,
): ReturnType<typeof coordination> {
  // Issue execution remains an additional restriction, never replaced by a turn.
  assertExecution(cfg, issue);
  return coordination(
    cfg,
    portOf(cfg, issue, true),
    JSON.stringify([cfg.repo, cfg.baseBranch, "integration"]),
    identityOf(cfg, issue),
  );
}
function assertExecution(cfg: Config, issue: number): void {
  assertReconciled(cfg, issue);
  issueExecution(cfg, issue).assertOwner();
}
// Internal functions also serve compatibility-reader unit tests. All runtime
// work requests carry an execution identity at the ops envelope boundary.
function guardExecution(cfg: Config, issue: number): void {
  if (cfg.execution !== undefined) {
    assertReconciled(cfg, issue);
    issueExecution(cfg, issue).assertOwner();
  }
}

function controlledMutation(cfg: Config, write: () => RunResult): RunResult {
  const { execution } = cfg;
  if (execution === undefined) {
    return write();
  }
  guardExecution(cfg, execution.issue);
  if (activeWrites.has(journalPath(cfg, execution.issue))) {
    return write();
  }
  let result: RunResult | undefined;
  confirmedWrite(cfg, execution.issue, "controlled mutation", {
    write: (): void => {
      result = write();
    },
    confirmed: (): boolean => result?.code === 0,
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
  const bound: Config = {
    ...cfg,
    execution: identity,
    mutation: (write: () => RunResult): RunResult =>
      controlledMutation(bound, write),
  };
  return bound;
}

function assertExecutionHistory(
  cfg: Config,
  issue: number,
  receipt: { request: number; instance: string } | undefined,
): void {
  if (cfg.execution === undefined) {
    return;
  }
  if (receipt === undefined) {
    throw new OpsError(
      "saved state predates instance fencing; explicit reconciliation required",
    );
  }
  const history = issueExecution(cfg, issue).read();
  if (
    !history.records.some(
      (record) =>
        record.kind === "request" &&
        record.id === receipt.request &&
        record.identity.instance === receipt.instance,
    )
  ) {
    throw new OpsError(
      "saved execution history is missing; explicit reconciliation required",
    );
  }
}

export {
  assertExecution,
  assertExecutionHistory,
  assertReconciled,
  confirmedWrite,
  guardExecution,
  integrationTurn,
  issueExecution,
  withExecution,
};
