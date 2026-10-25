// The uncertain-write journal of an issue's run folder: exactly one attempt
// of each coordination or controlled write, including across subprocesses
// and restarts. Each write in flight journals its exact intent in a file of
// its own process, so two jobs writing at the same instant don't mistake
// each other's writes for uncertain ones (#133): both go on, and the
// coordination protocol decides between them. A write whose outcome stays
// unknown is retained as `coordination-uncertain.json`; so is one whose
// process died mid-write, as its in-flight file outlives it. Either holds
// every later ownership read of the issue until a person reconciles it.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import type { Evidence } from "./coordination.ts";
import { OpsError } from "./ops-error.ts";

const RETAINED = /^coordination-uncertain(?:-\d+)?\.json$/u;
const IN_FLIGHT = /^coordination-inflight-(?<pid>\d+)\.json$/u;
const JSON_SUFFIX = /\.json$/u;
// This process's journals of the writes it has in flight.
const activeWrites = new Set<string>();

function journalPath(cfg: Config, issue: number): string {
  return path.join(paths.runDir(cfg, issue), "coordination-uncertain.json");
}
function inFlightPath(cfg: Config, issue: number): string {
  return path.join(
    paths.runDir(cfg, issue),
    `coordination-inflight-${process.pid}.json`,
  );
}
// Whether process `pid` still runs: a fresh observation, never a record.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
// The journal that holds the issue: a retained one, or an in-flight file no
// write is active in, of this process or of one that no longer runs.
// Another live process's write in flight holds nothing.
function heldJournal(cfg: Config, issue: number): string | null {
  const dir = paths.runDir(cfg, issue);
  if (!fs.existsSync(dir)) {
    return null;
  }
  for (const name of fs.readdirSync(dir).sort()) {
    const { pid } = IN_FLIGHT.exec(name)?.groups ?? {};
    const file = path.join(dir, name);
    if (
      RETAINED.test(name) ||
      (pid !== undefined &&
        !activeWrites.has(file) &&
        (Number(pid) === process.pid || !alive(Number(pid))))
    ) {
      return file;
    }
  }
  return null;
}
function assertReconciled(cfg: Config, issue: number): void {
  const held = heldJournal(cfg, issue);
  if (held !== null) {
    throw new OpsError(
      `uncertain coordination write retained at ${held}; explicit reconciliation required`,
    );
  }
}
// Whether this process has a journaled write of the issue in flight.
function writing(cfg: Config, issue: number): boolean {
  return activeWrites.has(inFlightPath(cfg, issue));
}
// Retains an in-flight journal whose outcome is unknown under the
// documented name, or under its process's when another write took it.
function retain(cfg: Config, issue: number, file: string): string {
  for (const target of [
    journalPath(cfg, issue),
    journalPath(cfg, issue).replace(JSON_SUFFIX, `-${process.pid}.json`),
  ]) {
    try {
      fs.linkSync(file, target);
      fs.unlinkSync(file);
      return target;
    } catch {
      // Taken by another retained write: try the next name.
    }
  }
  return file;
}
// A lost response is acceptable only when a fresh read proves the exact
// outcome. A write the target definitely refused changed nothing, so it
// clears too.
function confirmedWrite(
  cfg: Config,
  issue: number,
  operation: string,
  attempt: {
    write: () => void;
    confirmed: () => boolean;
    refused?: () => boolean;
    evidence?: Evidence;
  },
): void {
  const { write, confirmed } = attempt;
  assertReconciled(cfg, issue);
  const file = inFlightPath(cfg, issue);
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
  let settled = false;
  try {
    try {
      write();
    } catch {
      // Read-back, not a successful transport response, establishes authority.
    }
    if (!(confirmed() || attempt.refused?.() === true)) {
      throw new OpsError(
        `uncertain ${operation}; preserve ${journalPath(cfg, issue)} and reconcile without retrying`,
      );
    }
    settled = true;
    fs.rmSync(file, { force: true });
  } finally {
    activeWrites.delete(file);
    if (!settled) {
      retain(cfg, issue, file);
    }
  }
}

export { assertReconciled, confirmedWrite, writing };
