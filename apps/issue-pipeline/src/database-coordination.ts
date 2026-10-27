import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  Command,
  Consumer,
  Evidence,
  Scope,
  View,
} from "@ecosystem/db/protocol";
import { CONSUMER_STATE, RESPONSE, VIEW } from "@ecosystem/db/protocol";
import { z } from "zod";
import type { Config } from "./config.ts";
import { assertReconciled } from "./coordination-journal.ts";
import type { ExecutionCoordinator } from "./execution-coordinator.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";

function call<T>(cfg: Config, command: Command, schema: z.ZodType<T>): T {
  if (command.binding !== undefined) {
    assertReconciled(cfg, command.binding.issue);
  } else if (command.scope.kind === "issue") {
    assertReconciled(cfg, command.scope.issue);
  }
  if (cfg.coordination.backend !== "postgres") {
    throw new OpsError(
      "database coordination needs explicit PostgreSQL configuration",
    );
  }
  const file = ["database.mjs", "database.ts"]
    .map((name: string): string => path.join(import.meta.dirname, name))
    .find((candidate: string): boolean => fs.existsSync(candidate));
  if (file === undefined) {
    throw new OpsError(
      "database coordination entrypoint is missing; install the complete distribution",
    );
  }
  const result = run(process.execPath, [file], {
    input: JSON.stringify({
      credentialsEnvFile: cfg.coordination.credentialsEnvFile,
      command,
    }),
    allowFail: true,
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || result.timedOut) {
    throw new OpsError(
      "database coordination unconfirmed; reconcile the same invocation",
    );
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    raw = null;
  }
  const response = RESPONSE.safeParse(raw);
  if (!response.success) {
    throw new OpsError(
      "database coordination response invalid; reconcile the same invocation",
    );
  }
  if (!response.data.ok) {
    throw new OpsError(
      `coordination requires reconciliation: ${response.data.reason}`,
    );
  }
  const parsed = schema.safeParse(response.data.result);
  if (!parsed.success) {
    throw new OpsError(
      "database coordination result invalid; reconcile the same invocation",
    );
  }
  return parsed.data;
}
function commandOf(
  cfg: Config,
  scope: Scope,
  operation: Command["operation"],
): Command {
  const command: Command = {
    repo: cfg.repo,
    base: cfg.baseBranch,
    scope,
    operation,
  };
  if (cfg.execution !== undefined) {
    command.binding = cfg.execution;
  }
  if (cfg.buddyAuthorization !== undefined) {
    command.buddyRunId = cfg.buddyAuthorization.run;
    command.task = cfg.buddyAuthorization.task;
  }
  return command;
}
function databaseView(cfg: Config, scope: Scope): View {
  return call(cfg, commandOf(cfg, scope, "read"), VIEW);
}
function databaseSurvey(cfg: Config, cap: number): ReadonlyMap<number, View> {
  const scope: Scope = { kind: "model-session", slot: 1, cap };
  return new Map(
    call(
      cfg,
      commandOf(cfg, scope, "survey"),
      z.array(z.tuple([z.number().int().positive(), VIEW])),
    ),
  );
}
function databaseCoordination(cfg: Config, scope: Scope): ExecutionCoordinator {
  function change(
    operation: Command["operation"],
    extra: Partial<Pick<Command, "consumer" | "evidence">> = {},
  ): void {
    call(cfg, { ...commandOf(cfg, scope, operation), ...extra }, z.null());
  }
  return {
    read: (): View => databaseView(cfg, scope),
    tryAcquire: (): boolean =>
      call(cfg, commandOf(cfg, scope, "claim"), z.boolean()),
    assertOwner: (): void => change("assert"),
    save: (evidence: Evidence): void => change("save", { evidence }),
    release: (): void => change("release"),
    consumers: (): View["consumers"] =>
      call(cfg, commandOf(cfg, scope, "consumers"), z.array(CONSUMER_STATE)),
    report: (kind: "register" | "done", consumer: Consumer): void =>
      change(kind, { consumer }),
    retire: (): void => {
      // PostgreSQL prevents a turn from outliving its source issue claim.
      // There is no orphan-turn state for a replacement action to retire.
      throw new OpsError(
        "database integration turns retain issue execution; reconcile the original action",
      );
    },
  };
}

export { databaseCoordination, databaseSurvey, databaseView };
