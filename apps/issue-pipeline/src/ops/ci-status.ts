// The ci-status op: waits for a PR's required checks to finish, and reports
// whether they pass, which fail (with their failed logs in one file), or that
// the PR's head moved on.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { sleepMs } from "../process.ts";

// The time, and a way to wait, so tests can run the waits without real time.
interface Clock {
  now: () => number;
  sleep: (ms: number) => void;
}

type CiReply =
  | { status: "head-changed"; headSha: unknown }
  | { status: "pass" | "no-checks"; checks: string[] }
  | { status: "fail"; failing: string[]; logPath: string }
  | { status: "pending" };

const SYSTEM_CLOCK: Clock = { now: Date.now, sleep: sleepMs };
const MS_PER_MINUTE = 60_000;
// GitHub may not have registered checks yet right after a push.
const NO_CHECKS_GRACE_MS = 180_000;
const POLL_INTERVAL_MS = 30_000;
const FAILED_LOG_CHARS = 200_000;
const RUN_LINK = /actions\/runs\/(?<run>\d+)/u;

const REQUEST = z.looseObject({
  expectedSha: z.string().nullish(),
  number: z.number(),
  pr: z.number(),
  waitMinutes: z.number().nullish(),
});
const SETTINGS = z.looseObject({
  ciWaitMinutes: z.number(),
  repo: z.string(),
  requireCi: z.unknown().transform(Boolean),
});
const VIEW = z.looseObject({ headRefOid: z.unknown() });
const CHECKS = z.array(
  z.looseObject({
    bucket: z.unknown(),
    link: z.string().nullish(),
    name: z.string(),
  }),
);

type CiRequest = z.infer<typeof REQUEST>;
type Settings = z.infer<typeof SETTINGS>;
type Check = z.infer<typeof CHECKS>[number];

// One wait, as the request and the config set it.
interface Wait {
  cfg: Config;
  request: CiRequest;
  settings: Settings;
  clock: Clock;
  started: number;
}

// The PR's required checks, or none when gh printed no list of them.
function requiredChecks(wait: Wait): Check[] {
  const { cfg, request, settings } = wait;
  const args = ["pr", "checks", String(request.pr), "-R", settings.repo];
  const result = gh(
    cfg,
    "merge",
    [...args, "--required", "--json", "name,state,bucket,link"],
    {
      allowFail: true,
    },
  );
  try {
    const parsed = CHECKS.safeParse(JSON.parse(result.stdout));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Not JSON: no checks yet.
  }
  return [];
}

// Writes each failing check's name and link, and its run's failed log when
// its link names an Actions run, to one file under the issue's run dir.
function failReply(wait: Wait, failing: readonly Check[]): CiReply {
  const { cfg, request, settings, clock } = wait;
  const logPath = path.join(
    paths.runDir(cfg, request.number),
    `ci-${clock.now()}.log`,
  );
  const parts: string[] = [];
  for (const check of failing) {
    const { run } = RUN_LINK.exec(check.link ?? "")?.groups ?? {};
    parts.push(`===== ${check.name} (${String(check.link)}) =====`);
    if (run !== undefined) {
      const args = ["run", "view", run, "-R", settings.repo, "--log-failed"];
      const log = gh(cfg, "merge", args, { allowFail: true }).stdout;
      parts.push(log.slice(-FAILED_LOG_CHARS));
    }
  }
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, parts.join("\n"));
  return {
    status: "fail",
    failing: failing.map((check) => check.name),
    logPath,
  };
}

function noChecksReply(settings: Settings): CiReply {
  if (settings.requireCi) {
    return { status: "no-checks", checks: [] };
  }
  return { status: "pass", checks: [] };
}

function isFailing(check: Check): boolean {
  return check.bucket === "fail" || check.bucket === "cancel";
}

// The head-changed reply when the PR's head is no longer the one the request
// expects. The head is read on every poll, but compared only when the request
// names one.
function movedHead(wait: Wait): CiReply | undefined {
  const { cfg, request, settings } = wait;
  const args = ["pr", "view", String(request.pr), "-R", settings.repo];
  const view = ghJson(cfg, "merge", [...args, "--json", "headRefOid"]);
  const expected = request.expectedSha;
  if (expected === undefined || expected === null || expected === "") {
    return undefined;
  }
  const { headRefOid } = VIEW.parse(view);
  if (headRefOid === expected) {
    return undefined;
  }
  return { status: "head-changed", headSha: headRefOid };
}

// One look at the PR: a reply once its checks have settled, or undefined to
// keep waiting.
function poll(wait: Wait): CiReply | undefined {
  const { clock, settings } = wait;
  const moved = movedHead(wait);
  if (moved !== undefined) {
    return moved;
  }
  const checks = requiredChecks(wait);
  if (checks.length === 0) {
    if (clock.now() - wait.started > NO_CHECKS_GRACE_MS) {
      return noChecksReply(settings);
    }
    return undefined;
  }
  if (checks.some((check) => check.bucket === "pending")) {
    return undefined;
  }
  const failing = checks.filter(isFailing);
  if (failing.length === 0) {
    return { status: "pass", checks: checks.map((check) => check.name) };
  }
  return failReply(wait, failing);
}

function ciStatus(
  cfg: Config,
  request: unknown,
  clock: Clock = SYSTEM_CLOCK,
): CiReply {
  const parsed = REQUEST.parse(request);
  const settings = SETTINGS.parse(cfg);
  const started = clock.now();
  const minutes = parsed.waitMinutes ?? settings.ciWaitMinutes;
  const deadline = started + minutes * MS_PER_MINUTE;
  const wait: Wait = { cfg, clock, request: parsed, settings, started };
  for (;;) {
    const reply = poll(wait);
    if (reply !== undefined) {
      return reply;
    }
    if (clock.now() > deadline) {
      return { status: "pending" };
    }
    clock.sleep(POLL_INTERVAL_MS);
  }
}

export type { Clock };
export { ciStatus };
