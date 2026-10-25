// Resource reservations (`capacity-by-resource`, `shared-reservations`). A
// reservation is one slot of a capped resource, claimed by one invocation,
// its holder, and released only once every consumer registered on it has
// reported done. A run or process ending, an issue closing or an idle
// observation releases nothing, and an unknown, malformed or partial record
// holds rather than counting as free.
//
// Model sessions are shared slots: each slot is a coordination scope of the
// repository and base, claimed with the same fenced protocol as issue
// execution and read under the holder issue's confirmed execution. Its
// records are version 3 and live on the holder's issue. The other two
// resources keep what already reserves them, so there is no second pool: a
// target write is the target's integration turn (ops/land-turn.ts), and a
// test slot is the machine-local checkout slot (lane-slots.ts), whose
// project-facing ISSUE_PIPELINE_LANE_SLOT and ISSUE_PIPELINE_LANE_SLOTS
// variables stay as they are.
import type { Config } from "../config.ts";
import type {
  Consumer,
  ConsumerState,
  InvocationBinding,
  Snapshot,
} from "../coordination.ts";
import { CONSUMER } from "../coordination-record-schema.ts";
import { sameConsumer } from "../coordination-records.ts";
import { resourceSlot, resourceSurvey, withExecution } from "../execution.ts";
import { OpsError } from "../ops-error.ts";

type ResourceKind = "model-session" | "test-slot" | "target-write";
interface ResourceConsumer {
  kind: string;
  id: string;
}
interface ReservationHandle {
  resource: ResourceKind;
  slot: number;
  holder: string;
  // Records `consumer` before it starts. Registering it again while it runs
  // changes nothing; registering one that already reported done rejects.
  register: (consumer: ResourceConsumer) => Promise<void>;
  // Records that `consumer`, which was registered, is done. Call it only on
  // confirmed evidence, such as an observed process exit. Idempotent.
  done: (consumer: ResourceConsumer) => Promise<void>;
  // Releases the slot when every registered consumer has reported done;
  // otherwise, or when the records can't be read, it stays held.
  release: () => Promise<{ released: boolean; reason: string }>;
}
type Reservation =
  | { state: "reserved"; reservation: ReservationHandle }
  | { state: "waiting" | "held"; reason: string };
type Slot = ReturnType<typeof resourceSlot>;

const MODEL_SESSION = "model-session";

// `work`'s result, or its error as a rejection.
function later<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
function nameOf(consumer: Consumer): string {
  return `${consumer.kind}:${consumer.id}`;
}
function requests(view: Snapshot, instance: string): boolean {
  return view.pending.some((row) => row.binding.instance === instance);
}
function requested(view: Snapshot, instance: string): boolean {
  return view.records.some(
    (row) => row.kind === "request" && row.binding.instance === instance,
  );
}
function occupied(view: Snapshot): boolean {
  return view.owner !== null || view.pending.length > 0;
}

// The slot this invocation requests next: the one it already requests, or
// the first free slot within the cap it hasn't contended for before. A
// slot that anyone holds or requests counts against the cap, including one
// beyond a cap that has since shrunk.
function nextSlot(
  survey: ReadonlyMap<number, Snapshot>,
  instance: string,
  cap: number,
): { slot: number } | { waiting: string } {
  const mine = [...survey].filter(([, view]) => requests(view, instance));
  if (mine.length > 1) {
    throw new OpsError("this invocation requests several model-session slots");
  }
  const [own] = mine;
  if (own !== undefined) {
    return { slot: own[0] };
  }
  const taken = [...survey.values()].filter(occupied).length;
  if (taken >= cap) {
    return {
      waiting: `every model-session slot is taken: ${taken} held or requested, cap ${cap}`,
    };
  }
  const free = [...survey].find(
    ([slot, view]) =>
      slot <= cap && !occupied(view) && !requested(view, instance),
  );
  if (free === undefined) {
    return {
      waiting:
        "this invocation already contended for every free model-session slot; request under a new invocation",
    };
  }
  return { slot: free[0] };
}

function find(slot: Slot, consumer: Consumer): ConsumerState | undefined {
  return slot
    .consumers()
    .find((entry) => sameConsumer(entry.consumer, consumer));
}
function register(slot: Slot, consumer: Consumer): void {
  const entry = find(slot, consumer);
  if (entry?.done === true) {
    throw new OpsError(
      `model-session consumer ${nameOf(consumer)} already reported done; register a new consumer`,
    );
  }
  if (entry === undefined) {
    slot.report("register", consumer);
  }
}
function reportDone(slot: Slot, consumer: Consumer): void {
  const entry = find(slot, consumer);
  if (entry === undefined) {
    throw new OpsError(
      `model-session consumer ${nameOf(consumer)} was never registered`,
    );
  }
  if (!entry.done) {
    slot.report("done", consumer);
  }
}
function release(
  slotOf: () => Slot,
  instance: string,
): { released: boolean; reason: string } {
  try {
    const slot = slotOf();
    const view = slot.read();
    if (!requests(view, instance)) {
      if (
        view.records.some(
          (row) => row.kind === "release" && row.instance === instance,
        )
      ) {
        return { released: true, reason: "already released" };
      }
      return {
        released: false,
        reason: "this invocation holds no model-session slot",
      };
    }
    const outstanding = slot.consumers().filter((entry) => !entry.done);
    if (outstanding.length > 0) {
      const names = outstanding.map((entry) => nameOf(entry.consumer));
      return {
        released: false,
        reason: `held for consumers not yet done: ${names.join(", ")}`,
      };
    }
    slot.release();
    return {
      released: true,
      reason: "every registered consumer reported done",
    };
  } catch (error) {
    return {
      released: false,
      reason: `model-session reservation held: ${messageOf(error)}`,
    };
  }
}

function handleOf(
  cfg: Config,
  execution: InvocationBinding,
  slot: number,
): ReservationHandle {
  function slotOf(): Slot {
    return resourceSlot(cfg, execution.issue, MODEL_SESSION, slot);
  }
  return {
    resource: MODEL_SESSION,
    slot,
    holder: execution.instance,
    register: (consumer: ResourceConsumer): Promise<void> =>
      later(() => register(slotOf(), CONSUMER.parse(consumer))),
    done: (consumer: ResourceConsumer): Promise<void> =>
      later(() => reportDone(slotOf(), CONSUMER.parse(consumer))),
    release: (): Promise<{ released: boolean; reason: string }> =>
      later(() => release(slotOf, execution.instance)),
  };
}

function reserve(
  cfg: Config,
  execution: InvocationBinding,
  cap: number,
): Reservation {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    return {
      state: "held",
      reason: `the model-session cap must be a positive integer, not ${cap}`,
    };
  }
  const bound = withExecution(cfg, execution);
  const { issue, instance } = execution;
  // A lost contention cancels its request and never requests that slot
  // again, so there are at most cap + 1 attempts.
  for (let attempt = 0; attempt <= cap; attempt += 1) {
    const next = nextSlot(
      resourceSurvey(bound, issue, MODEL_SESSION, cap),
      instance,
      cap,
    );
    if ("waiting" in next) {
      return { state: "waiting", reason: next.waiting };
    }
    const slot = resourceSlot(bound, issue, MODEL_SESSION, next.slot);
    slot.request();
    if (slot.acquire()) {
      return {
        state: "reserved",
        reservation: handleOf(bound, execution, next.slot),
      };
    }
    slot.cancel();
  }
  return {
    state: "waiting",
    reason: "lost every model-session slot this invocation contended for",
  };
}

// Reserves a model-session slot of cfg's repository for invocation
// `execution`, which must hold its issue's confirmed execution, under a cap
// of `cap` slots. A full pool waits and leaves no request behind; unreadable
// or contradictory records hold. Calling it again for the same invocation
// returns the slot it already holds.
function reserveModelSession(
  cfg: Config,
  execution: InvocationBinding,
  cap: number,
): Promise<Reservation> {
  return later((): Reservation => {
    try {
      return reserve(cfg, execution, cap);
    } catch (error) {
      return {
        state: "held",
        reason: `model-session reservation held: ${messageOf(error)}`,
      };
    }
  });
}

export type { Reservation, ReservationHandle, ResourceConsumer, ResourceKind };
export { reserveModelSession };
