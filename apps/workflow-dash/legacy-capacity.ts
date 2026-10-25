import type { HistoricalJob } from "./job-history.ts";

const authorImplementationStage = /^(?:implement|author)/u;
const hardeningStage = /review/u;
const verificationLaunch = /^verify-/u;
const legacyTotalSlots = 4;
const legacyGroupSlots = 2;
interface LegacyCapacity {
  activeRuns: number;
  limit: number;
  authorImplementation: number;
  hardening: number;
  authorImplementationLimit: number;
  hardeningLimit: number;
  pbWeb: number[];
}
function currentWebGate(run: HistoricalJob): boolean {
  const launch = run.data.launches.at(-1);
  return (
    run.repo.endsWith("/project-buddy") &&
    (run.data.scope === "pb-web" ||
      run.pbWebObserved === true ||
      verificationLaunch.test(launch?.key ?? "") ||
      launch?.scope === "pb-web")
  );
}
/** Retained deprecated-tool contract, not configured capacity or resource leases. */
function capacity(runs: HistoricalJob[]): LegacyCapacity {
  const active = runs.filter((run) => run.live === true);
  return {
    activeRuns: active.length,
    limit: legacyTotalSlots,
    authorImplementation: active.filter((run) =>
      authorImplementationStage.test(run.data.stage ?? ""),
    ).length,
    hardening: active.filter((run) => hardeningStage.test(run.data.stage ?? ""))
      .length,
    authorImplementationLimit: legacyGroupSlots,
    hardeningLimit: legacyGroupSlots,
    pbWeb: active.filter(currentWebGate).map((run) => run.issue),
  };
}

export type { LegacyCapacity };
export { capacity };
