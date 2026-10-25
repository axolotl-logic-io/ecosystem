// The executed half of a standards assessment (#129): install, tests and the
// advisory scan, run in the credential-free sandbox (sandbox.ts) on a fresh
// export of the source commit. For Node/npm, npm's own code fetches first,
// with the network and no repository scripts: `npm ci --ignore-scripts`,
// then `npm audit`, to a registry the operator chose. Only then does
// repository code run, with no network: `npm rebuild` (dependency install
// scripts) and `npm test`. The criteria hold only exit codes and audit
// counts; what the commands printed goes to logs the caller keeps locally,
// because repository code wrote it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { Sandbox, SandboxRun } from "./sandbox.ts";
import { inSandbox, NODE_DIR, NPM_CLI, openSandbox } from "./sandbox.ts";
import type { Command, Criterion, SandboxRecord } from "./schema.ts";
import type { Source } from "./source.ts";

// Each command's time limit.
const COMMAND_MS = 600_000;
const MS_PER_MINUTE = 60_000;
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json"];
const SEVERITIES = ["critical", "high", "moderate", "low", "info"];
const LOCAL_SPEC = /^(?:file|link|workspace):/u;
const AUDIT = z.looseObject({
  metadata: z.looseObject({
    vulnerabilities: z.record(z.string(), z.number()),
    dependencies: z.looseObject({ total: z.number() }).optional(),
  }),
});

interface Log {
  // A file name under OUT_DIR/logs.
  name: string;
  text: string;
}

interface Execution {
  sandbox: SandboxRecord | null;
  commands: Command[];
  logs: Log[];
  // environment.install, vulnerabilities.scan and behavior.tests-run.
  criteria: Criterion[];
}

interface Options {
  // The registry every npm fetch goes to; null runs nothing (`--static`).
  registry: string | null;
}

function unrun(reason: string): Criterion[] {
  return [
    { id: "environment.install", status: "unverified", evidence: reason },
    {
      id: "vulnerabilities.scan",
      status: "unverified",
      evidence: `${reason}; no advisory scanner ran, so this is not a clean scan`,
    },
    { id: "behavior.tests-run", status: "unverified", evidence: reason },
  ];
}

function nothingRun(sandbox: SandboxRecord | null, reason: string): Execution {
  return { sandbox, commands: [], logs: [], criteria: unrun(reason) };
}

// Every "resolved" URL in a lockfile, at any depth (lockfile v1 nests them).
function resolvedIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(resolvedIn);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, inner]) => {
    if (key === "resolved" && typeof inner === "string") {
      return [inner];
    }
    return resolvedIn(inner);
  });
}

// The first package the lockfile fetches from outside `registry`, or null.
function outsideRegistry(text: string, registry: string): string | null {
  let lock: unknown = null;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  const outside = resolvedIn(lock).find(
    (url) => !(url.startsWith(registry) || LOCAL_SPEC.test(url)),
  );
  return outside ?? null;
}

class Steps {
  readonly commands: Command[] = [];
  readonly logs: Log[] = [];
  readonly #sandbox: Sandbox;
  readonly #work: string;
  readonly #cache: string;
  readonly #registry: string;

  constructor(sandbox: Sandbox, work: string, cache: string, registry: string) {
    this.#sandbox = sandbox;
    this.#work = work;
    this.#cache = cache;
    this.#registry = registry;
  }

  // Runs `npm ARGS` in a fresh sandbox, with the network only when asked.
  npm(args: readonly string[], network: boolean): SandboxRun {
    const result = inSandbox(this.#sandbox, {
      argv: [`${NODE_DIR}/bin/node`, NPM_CLI, ...args],
      work: this.#work,
      cache: this.#cache,
      network,
      timeoutMs: COMMAND_MS,
      env: new Map([["npm_config_registry", this.#registry]]),
    });
    const name = `${this.commands.length + 1}-npm-${args[0] ?? "run"}.log`;
    this.logs.push({ name, text: result.output });
    this.commands.push({
      argv: ["npm", ...args],
      network,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      log: `logs/${name}`,
    });
    return result;
  }
}

function exited(step: string, result: SandboxRun, limitMs: number): string {
  if (result.exitCode === null) {
    return `${step} didn't finish within ${limitMs / MS_PER_MINUTE} minutes`;
  }
  return `${step} exited ${result.exitCode}`;
}

function scanCriterion(result: SandboxRun, registry: string): Criterion {
  const id = "vulnerabilities.scan";
  let report: z.infer<typeof AUDIT> | null = null;
  try {
    report = AUDIT.parse(JSON.parse(result.stdout));
  } catch {
    report = null;
  }
  if (report === null) {
    return {
      id,
      status: "unverified",
      evidence: `${exited("npm audit", result, COMMAND_MS)} without a report; no clean scan`,
    };
  }
  const { vulnerabilities, dependencies } = report.metadata;
  const scope = `npm audit against ${registry}, dev dependencies included, over ${dependencies?.total ?? "unknown"} dependencies`;
  const found = SEVERITIES.filter(
    (severity) => (vulnerabilities[severity] ?? 0) > 0,
  );
  if (found.length === 0) {
    return { id, status: "passed", evidence: `${scope}: no advisories` };
  }
  const counts = found.map(
    (severity) => `${vulnerabilities[severity]} ${severity}`,
  );
  return {
    id,
    status: "failed",
    evidence: `${scope}: ${counts.join(", ")}`,
  };
}

function nodeRuns(steps: Steps, registry: string): Criterion[] {
  const ci = steps.npm(["ci", "--ignore-scripts", "--no-audit"], true);
  if (ci.exitCode !== 0) {
    const failed = exited("npm ci --ignore-scripts", ci, COMMAND_MS);
    return [
      { id: "environment.install", status: "failed", evidence: failed },
      ...unrun(`not run: ${failed}`).slice(1),
    ];
  }
  const scan = scanCriterion(steps.npm(["audit", "--json"], true), registry);
  const rebuild = steps.npm(["rebuild", "--foreground-scripts"], false);
  if (rebuild.exitCode !== 0) {
    const failed = `${exited("npm rebuild", rebuild, COMMAND_MS)} running dependency install scripts with no network`;
    return [
      { id: "environment.install", status: "failed", evidence: failed },
      scan,
      {
        id: "behavior.tests-run",
        status: "unverified",
        evidence: `not run: ${failed}`,
      },
    ];
  }
  const test = steps.npm(["test"], false);
  let tests: Criterion = {
    id: "behavior.tests-run",
    status: "passed",
    evidence: "npm test exited 0 with no network",
  };
  if (test.exitCode !== 0) {
    tests = {
      id: "behavior.tests-run",
      status: "failed",
      evidence: `${exited("npm test", test, COMMAND_MS)} with no network`,
    };
  }
  return [
    {
      id: "environment.install",
      status: "passed",
      evidence:
        "npm ci --ignore-scripts exited 0, then npm rebuild ran dependency install scripts with no network and exited 0",
    },
    scan,
    tests,
  ];
}

// Installs, scans and tests a Node/npm source in the sandbox, or says why
// it didn't.
function executeNode(source: Source, options: Options): Execution {
  const { registry } = options;
  if (registry === null) {
    return nothingRun(
      null,
      "not run: the assessment ran statically (--static)",
    );
  }
  const { sandbox, reason } = openSandbox();
  if (sandbox === null) {
    return nothingRun(
      { tool: "bwrap", version: null, detail: reason, registry, npm: null },
      `not run: no sandbox on this host (${reason})`,
    );
  }
  const record: SandboxRecord = {
    tool: "bwrap",
    version: sandbox.version,
    detail:
      "no credentials, empty home, private /tmp and PID namespace; network only for npm ci --ignore-scripts and npm audit",
    registry,
    npm: sandbox.npmVersion,
  };
  const lock = NPM_LOCKS.find((file) => source.files.includes(file));
  if (lock === undefined) {
    return nothingRun(
      record,
      "not run: no package-lock.json or npm-shrinkwrap.json for npm ci to install from",
    );
  }
  const outside = outsideRegistry(source.read(lock) ?? "", registry);
  if (outside !== null) {
    return nothingRun(
      record,
      `not run: ${lock} fetches ${outside} from outside the registry ${registry}`,
    );
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "standards-work-"));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "standards-cache-"));
  try {
    source.exportTo(work);
    const steps = new Steps(sandbox, work, cache, registry);
    const criteria = nodeRuns(steps, registry);
    return {
      sandbox: record,
      commands: steps.commands,
      logs: steps.logs,
      criteria,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

function onPath(tool: string): boolean {
  const { PATH: searched = "" } = process.env;
  const dirs = searched.split(path.delimiter);
  return dirs.some((dir) => dir !== "" && fs.existsSync(path.join(dir, tool)));
}

function missing(tool: string, use: string): string {
  if (onPath(tool)) {
    return `not run: ${tool} is on this host, but sandboxed ${use} isn't built yet`;
  }
  return `not run: ${tool} isn't on this host, so ${use} can't run`;
}

// A Python/Poetry source's executed criteria. Poetry's install and pytest
// need `poetry`, and the scan needs `pip-audit`; each is reported missing.
function executePoetry(options: Options): Execution {
  if (options.registry === null) {
    return nothingRun(
      null,
      "not run: the assessment ran statically (--static)",
    );
  }
  const install = missing("poetry", "a Poetry install");
  return {
    sandbox: null,
    commands: [],
    logs: [],
    criteria: [
      { id: "environment.install", status: "unverified", evidence: install },
      {
        id: "vulnerabilities.scan",
        status: "unverified",
        evidence: `${missing("pip-audit", "an advisory scan")}: scanner missing, so this is not a clean scan`,
      },
      {
        id: "behavior.tests-run",
        status: "unverified",
        evidence: `${install}, and pytest needs the installed environment`,
      },
    ],
  };
}

export type { Execution, Log, Options };
export { executeNode, executePoetry, nothingRun };
