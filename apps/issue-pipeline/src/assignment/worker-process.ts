import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { childEnvironment } from "../child-env.ts";
import { closeClaim, liveClaims, touchClaim } from "../claims.ts";
import { listComments } from "../comments.ts";
import { paths } from "../config.ts";
import { readStatus } from "../job/status.ts";
import { OpsError } from "../ops-error.ts";
import { ROOT } from "../pipeline-root.ts";
import { endGroup } from "../process-group.ts";
import { readClaimState } from "../saved-state.ts";
import { assertExecution, executionLane } from "./authority.ts";
import { verifyCheckpoint } from "./checkpoint.ts";
import type { RuntimeRepository } from "./runtime.ts";
import type { Execution } from "./schema.ts";
import type { JobResult } from "./worker-state.ts";

const RESULT = z.object({
  issue: z.number(),
  stage: z.string(),
  end: z.enum(["next", "wait", "ask", "stop", "deferred", "done", "unclaimed"]),
  reason: z.string().optional(),
});
const KILL_GRACE_MS = 30_000;
const OUTPUT_LENGTH = 10_000;
const MS_PER_SECOND = 1000;
const DEFAULT_HEARTBEAT_SECONDS = 60;
interface StageChild {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
  id: string;
  execution: Execution;
  repository: RuntimeRepository;
}
function startChild(
  repository: RuntimeRepository,
  execution: Execution,
  branch: string,
): StageChild {
  const { cfg, config, brainPath } = repository;
  const state = readClaimState(
    cfg,
    execution.issue,
    listComments(cfg, execution.issue),
  );
  if (state !== null) {
    verifyCheckpoint(cfg, state);
  }
  const id = randomUUID();
  fs.mkdirSync(paths.runDir(cfg, execution.issue), { recursive: true });
  const log = fs.openSync(paths.jobLog(cfg, execution.issue), "a");
  const argv = [
    path.join(ROOT, "job.mjs"),
    "--config",
    config,
    "--brain-path",
    brainPath,
    "--issue",
    String(execution.issue),
    "--stage",
    execution.stage,
    "--branch",
    branch,
    "--lane",
    executionLane(execution.token),
    "--job-id",
    id,
    "--execution",
    JSON.stringify(execution),
  ];
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, argv, {
      detached: true,
      env: childEnvironment(process.env),
      stdio: ["ignore", "pipe", log],
    });
  } finally {
    fs.closeSync(log);
  }
  let output = "";
  child.stdout?.on("data", (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_LENGTH);
  });
  const exited = new Promise<number | null>((resolve, reject): void => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    child,
    exited,
    output: (): string => output,
    id,
    execution,
    repository,
  };
}
function resultOf(stage: StageChild): JobResult {
  const {
    execution,
    repository: { cfg },
    id,
  } = stage;
  const lines = stage.output().trim().split("\n");
  const result = RESULT.parse(JSON.parse(lines.at(-1) ?? "null"));
  const status = readStatus(paths.runDir(cfg, execution.issue));
  if (
    result.issue !== execution.issue ||
    result.stage !== execution.stage ||
    status?.id !== id ||
    status.outcome === null
  ) {
    throw new OpsError(
      "stage outcome or recovery evidence cannot be confirmed",
    );
  }
  const localRecovery =
    (status.droppedPatches?.length ?? 0) > 0 ||
    (status.lostChanges?.length ?? 0) > 0 ||
    fs.existsSync(paths.jobCheckout(cfg, execution.issue, execution.stage));
  for (const claim of liveClaims(cfg, listComments(cfg, execution.issue))) {
    if (claim.lane === executionLane(execution.token)) {
      closeClaim(
        cfg,
        claim,
        "Stage child ended; execution ref remains until supervisor checkpoint confirmation.",
      );
    }
  }
  return { end: result.end, reason: result.reason ?? null, localRecovery };
}
interface Monitor {
  check: () => Promise<void>;
  close: () => Promise<void>;
}
function monitor(stage: StageChild, signal: AbortSignal): Monitor {
  const {
    child,
    exited,
    execution,
    repository: { cfg },
  } = stage;
  let refusing: Error | null = null;
  let ending: Promise<unknown> | null = null;
  function stop(error: Error): void {
    refusing = error;
    if (ending === null && child.pid !== undefined) {
      ending = endGroup(child.pid, exited, KILL_GRACE_MS);
    }
  }
  function abort(): void {
    stop(
      new Error(
        "worker stopped; preserve execution and reconcile retained work",
      ),
    );
  }
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  const heartbeat = setInterval(
    (): void => {
      try {
        assertExecution({ ...cfg, execution }, execution.issue, true);
        touchClaim(cfg, execution.issue, {
          lane: executionLane(execution.token),
          sweepId: stage.id,
        });
      } catch (error: unknown) {
        stop(
          new Error("work grant or heartbeat cannot be verified", {
            cause: error,
          }),
        );
      }
    },
    (cfg.assignment?.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS) *
      MS_PER_SECOND,
  );
  return {
    check: async (): Promise<void> => {
      if (ending !== null) {
        await ending;
      }
      if (refusing !== null) {
        throw refusing;
      }
    },
    close: async (): Promise<void> => {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      if (
        child.exitCode === null &&
        child.signalCode === null &&
        child.pid !== undefined
      ) {
        await endGroup(child.pid, exited, KILL_GRACE_MS);
      }
    },
  };
}
async function awaitChild(
  stage: StageChild,
  signal: AbortSignal,
): Promise<JobResult> {
  const watch = monitor(stage, signal);
  try {
    const code = await stage.exited;
    await watch.check();
    if (code !== 0) {
      throw new OpsError(
        `stage child exited ${code}; inspect retained recovery evidence`,
      );
    }
    return resultOf(stage);
  } finally {
    await watch.close();
  }
}

async function runJob(
  repository: RuntimeRepository,
  execution: Execution,
  branch: string,
  signal: AbortSignal,
): Promise<JobResult> {
  const scoped = {
    ...execution,
    scope: {
      manifest: repository.manifest,
      config: repository.config,
      brainPath: repository.brainPath,
    },
  };
  return await awaitChild(startChild(repository, scoped, branch), signal);
}

export { runJob };
