// Issue-wide barriers to releasing execution. The action runtime separately
// requires a settled result/checkpoint and lossless checkout preservation.
import type { Config } from "../config.ts";
import { assertReconciled } from "../coordination-journal.ts";
import { registeredConsumers } from "../lane-slots.ts";

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function refusalOf(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error: unknown) {
    return messageOf(error);
  }
}

function assertNoConsumer(cfg: Config, issue: number): void {
  const consumers = registeredConsumers(cfg, issue, null);
  if (consumers.length > 0) {
    throw new Error(
      `the lane slot still has registered consumers: ${consumers.join(", ")}`,
    );
  }
}

function issueRefusal(cfg: Config, issue: number): string | null {
  return (
    refusalOf((): void => assertReconciled(cfg, issue)) ??
    refusalOf((): void => assertNoConsumer(cfg, issue))
  );
}

export { issueRefusal };
