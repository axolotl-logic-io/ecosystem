// One invocation of a model-session reservation, run as its own process the
// way the buddy runtime runs an action: it loads a real config file, takes
// its issue's execution through the real transport, then runs the steps of
// its plan (stdin) against src/runtime/reservations.ts and prints each
// step's outcome as one JSON line. A step that rejects prints its reason;
// the driver goes on. Ending the process releases nothing.
import fs from "node:fs";
import process from "node:process";
import { z } from "zod";
import { loadConfig } from "../../src/config.ts";
import { issueExecution, withExecution } from "../../src/execution.ts";
import type { ReservationHandle } from "../../src/runtime/reservations.ts";
import { reserveModelSession } from "../../src/runtime/reservations.ts";

const STEP = z.discriminatedUnion("do", [
  z.object({ do: z.literal("reserve"), cap: z.number() }),
  z.object({
    do: z.enum(["register", "done"]),
    consumer: z.object({ kind: z.string(), id: z.string() }),
  }),
  z.object({ do: z.literal("release") }),
]);
const PLAN = z.object({
  config: z.string(),
  instance: z.string(),
  issue: z.number(),
  steps: z.array(STEP),
});
type Step = z.infer<typeof STEP>;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function run(
  step: Step,
  handle: ReservationHandle | null,
  reserve: (cap: number) => ReturnType<typeof reserveModelSession>,
): Promise<ReservationHandle | null> {
  if (step.do === "reserve") {
    const result = await reserve(step.cap);
    if (result.state !== "reserved") {
      print(result);
      return handle;
    }
    const { reservation } = result;
    print({
      state: result.state,
      resource: reservation.resource,
      slot: reservation.slot,
      holder: reservation.holder,
    });
    return reservation;
  }
  if (handle === null) {
    throw new Error(`no reservation to ${step.do}`);
  }
  if (step.do === "release") {
    print(await handle.release());
    return handle;
  }
  try {
    await handle[step.do](step.consumer);
    print({ [step.do]: "recorded" });
  } catch (error) {
    print({ [step.do]: "rejected", reason: messageOf(error) });
  }
  return handle;
}

async function main(): Promise<void> {
  const plan = PLAN.parse(JSON.parse(fs.readFileSync(0, "utf8")));
  const cfg = loadConfig(plan.config);
  const execution = {
    instance: plan.instance,
    lane: `lane-${plan.issue}`,
    issue: plan.issue,
    branch: `agent/issue-${plan.issue}`,
    repo: cfg.repo,
    base: cfg.baseBranch,
  };
  const bound = withExecution(cfg, execution);
  const issue = issueExecution(bound, plan.issue);
  if (!issue.tryAcquire()) {
    throw new Error(`issue ${plan.issue}'s execution is not this invocation's`);
  }
  // The steps run in order, each on the handle the last reserve returned.
  await plan.steps.reduce(
    async (previous: Promise<ReservationHandle | null>, step) =>
      run(step, await previous, (cap) =>
        reserveModelSession(cfg, execution, cap),
      ),
    Promise.resolve(null),
  );
}

await main();
