import { z } from "zod";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { acquire, releaseLock } from "./exclusion.ts";
import type { Hub } from "./github.ts";
import { pages } from "./github.ts";
import { RetryHold } from "./retry.ts";
import { DEFAULT_PAGE_BUDGET } from "./schema.ts";
import { sweep } from "./worker.ts";
import type { WorkerDeps } from "./worker-state.ts";

const MS_PER_SECOND = 1000;
const MAX_EXPONENT = 20;
const REF = z.object({ ref: z.string() });
const RETRY_REF = /^refs\/heads\/pipeline-retry\/(?<until>\d+)-/u;
function retryHold(hub: Hub, cfg: Config): number {
  const refs = pages(
    hub,
    "git/matching-refs/heads/pipeline-retry/",
    REF,
    cfg.assignment?.pageBudget ?? DEFAULT_PAGE_BUDGET,
  );
  return refs.reduce((until, ref) => {
    const { until: stamp } = RETRY_REF.exec(ref.ref)?.groups ?? {};
    return Math.max(until, Number(stamp ?? 0));
  }, 0);
}
function saveRetry(hub: Hub, cfg: Config, until: number): void {
  acquire(
    hub,
    cfg,
    `heads/pipeline-retry/${until}-${crypto.randomUUID()}`,
    `retry until ${new Date(until).toISOString()}`,
  );
}
interface PollRepository {
  cfg: Config;
  deps: WorkerDeps;
}
interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  report: (repo: string, reason: string) => void;
}
interface Polling {
  worker: string;
  clock: PollClock;
  failures: Map<string, number>;
}
function defer(
  repository: PollRepository,
  polling: Polling,
  error: unknown,
): number {
  const { cfg, deps } = repository;
  const { clock, failures } = polling;
  const settings = cfg.assignment;
  if (settings === undefined) {
    throw new OpsError("assignment mode disabled");
  }
  const count = (failures.get(cfg.repo) ?? 0) + 1;
  failures.set(cfg.repo, count);
  let ms =
    Math.min(
      settings.maxBackoffSeconds,
      settings.pollSeconds * 2 ** Math.min(count, MAX_EXPONENT),
    ) * MS_PER_SECOND;
  if (error instanceof RetryHold) {
    ms = Math.max(ms, error.until - clock.now());
  }
  let reason = "incomplete discovery";
  if (error instanceof Error) {
    reason = error.message;
  }
  clock.report(cfg.repo, reason);
  const at = clock.now() + ms;
  // If saving retry authority fails, the caller leaves its discovery ref
  // held and exits. A replacement must reconcile it, not bypass the hold.
  saveRetry(deps.hub, cfg, at);
  return at;
}
async function attempt(
  repository: PollRepository,
  polling: Polling,
): Promise<number> {
  const { cfg, deps } = repository;
  const { worker, clock, failures } = polling;
  if (cfg.assignment === undefined) {
    throw new OpsError("worker repository lacks assignment opt-in");
  }
  deps.scope();
  const normal = clock.now() + cfg.assignment.pollSeconds * MS_PER_SECOND;
  const ref = `heads/pipeline-discovery/${worker}`;
  const token = acquire(deps.hub, cfg, ref, worker);
  if (token === null) {
    clock.report(
      cfg.repo,
      "active or stalled discovery owner; inspect pipeline-discovery ref and reconcile before replacement",
    );
    return normal;
  }
  try {
    const hold = retryHold(deps.hub, cfg);
    if (hold > clock.now()) {
      releaseLock(deps.hub, ref, token);
      return hold;
    }
    await sweep(cfg, worker, deps);
    failures.delete(cfg.repo);
    releaseLock(deps.hub, ref, token);
    return clock.now() + cfg.assignment.pollSeconds * MS_PER_SECOND;
  } catch (error: unknown) {
    const at = defer(repository, polling, error);
    releaseLock(deps.hub, ref, token);
    return at;
  }
}
function cadence(
  clock: PollClock,
  due: ReadonlyMap<string, number>,
  once: boolean,
): AsyncIterable<number> {
  let initial = true;
  const iterator: AsyncIterableIterator<number> = {
    [Symbol.asyncIterator]: (): AsyncIterableIterator<number> => iterator,
    next: async (): Promise<IteratorResult<number>> => {
      if (clock.stopped() || (once && !initial)) {
        return { done: true, value: 0 };
      }
      if (!initial) {
        await clock.sleep(Math.max(1, Math.min(...due.values()) - clock.now()));
      }
      initial = false;
      return { done: clock.stopped(), value: clock.now() };
    },
  };
  return iterator;
}

// Only disposable timing lives here. Every attempt consults GitHub retry
// holds and reconstructs candidates; no private scheduler DB is introduced.
async function poll(
  repositories: readonly PollRepository[],
  worker: string,
  clock: PollClock,
  once = false,
): Promise<void> {
  const polling = { worker, clock, failures: new Map<string, number>() };
  const due = new Map<string, number>();
  for await (const at of cadence(clock, due, once)) {
    for await (const repository of repositories) {
      if (!clock.stopped() && (due.get(repository.cfg.repo) ?? 0) <= at) {
        due.set(repository.cfg.repo, await attempt(repository, polling));
      }
    }
  }
}

export type { PollClock, PollRepository };
export { poll, retryHold, saveRetry };
