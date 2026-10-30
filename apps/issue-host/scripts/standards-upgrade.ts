#!/usr/bin/env node

// The repository standards upgrade's entrypoint (#129,
// docs/reference/standards-upgrade.md). build.ts bundles it as
// dist/standards-upgrade.mjs, which the installer includes. No buddy schedules it.
//
//   node standards-upgrade.mjs assess --config CONFIG --repo OWNER/REPO|URL
//        [--ref REF] [--npm-registry URL] [--pypi-index URL]
//        [--python-tools FILE] [--static] --out DIR
//   node standards-upgrade.mjs apply --config CONFIG --issue N
//
// `assess` reads the configured repository at REF (its default branch when
// omitted), resolved to one commit, and writes assessment.json, report.md
// and, when an upgrade has something to change, plan.md into DIR, an
// existing empty folder. It runs install, tests and the advisory scan in a
// credential-free sandbox, fetching only from the npm registry (the public
// one by default) or, for Poetry, pip's tools from the index (PyPI by
// default) as FILE pins them (the shipped pins by default), and keeps what
// they printed in DIR/logs; `--static` runs nothing. It writes nothing to GitHub or the origin. It prints one JSON
// line naming the verdict and the files. A wrong repository, an unreadable one or a ref that names no commit
// exits 2 with the reason on stderr, before anything is written; other
// errors exit 1.
//
// `apply` admits issue N, which an allow-listed person filed from plan.md,
// into issue delivery: it checks the plan's author, repository, policy,
// source commit (still the base branch's head) and that no other open issue
// carries a plan, then prints the issue branch and the human start-label
// request for Implement. It reads only; the qualified label and the buddy's
// task guards remain necessary. A plan that fails a check exits 2.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { admit } from "../src/standards/admit.ts";
import { assess } from "../src/standards/assess.ts";
import { defaultPythonTools } from "../src/standards/execute-poetry.ts";
import { planOf, reportOf } from "../src/standards/report.ts";
import { Refusal } from "../src/standards/source.ts";

const FAILED = 1;
const REFUSED = 2;
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_INDEX = "https://pypi.org/simple/";
const REGISTRY_URL = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/u;
const TRAILING_SLASH = /\/?$/u;
const ASSESS_ARGS = z.object({
  config: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().optional(),
  out: z.string().min(1),
  "npm-registry": z.string().regex(REGISTRY_URL).optional(),
  "pypi-index": z.string().regex(REGISTRY_URL).optional(),
  "python-tools": z.string().min(1).optional(),
  static: z.boolean().optional(),
});
const APPLY_ARGS = z.object({
  config: z.string().min(1),
  issue: z.coerce.number().int().positive(),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function emptyFolder(dir: string): string {
  const resolved = path.resolve(dir);
  if (
    !fs.statSync(resolved).isDirectory() ||
    fs.readdirSync(resolved).length > 0
  ) {
    throw new Error(`--out must name an existing empty folder: ${dir}`);
  }
  return resolved;
}

function runAssess(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      repo: { type: "string" },
      ref: { type: "string" },
      out: { type: "string" },
      "npm-registry": { type: "string" },
      "pypi-index": { type: "string" },
      "python-tools": { type: "string" },
      static: { type: "boolean" },
    },
  });
  const args = ASSESS_ARGS.parse(values);
  const fetching = ["npm-registry", "pypi-index", "python-tools"] as const;
  if (
    args.static === true &&
    fetching.some((flag) => args[flag] !== undefined)
  ) {
    throw new Error(
      "--static runs nothing, so it takes no --npm-registry, --pypi-index or --python-tools",
    );
  }
  const out = emptyFolder(args.out);
  let registry: string | null = (
    args["npm-registry"] ?? DEFAULT_REGISTRY
  ).replace(TRAILING_SLASH, "/");
  if (args.static === true) {
    registry = null;
  }
  const { assessment, logs } = assess(
    loadConfig(args.config),
    args.repo,
    args.ref ?? null,
    {
      now: new Date(),
      registry,
      pypiIndex: (args["pypi-index"] ?? DEFAULT_INDEX).replace(
        TRAILING_SLASH,
        "/",
      ),
      pythonTools: path.resolve(args["python-tools"] ?? defaultPythonTools()),
    },
  );
  if (logs.length > 0) {
    fs.mkdirSync(path.join(out, "logs"));
    for (const log of logs) {
      fs.writeFileSync(path.join(out, "logs", log.name), log.text);
    }
  }
  const files = {
    assessment: path.join(out, "assessment.json"),
    report: path.join(out, "report.md"),
  };
  fs.writeFileSync(
    files.assessment,
    `${JSON.stringify(assessment, null, 2)}\n`,
  );
  fs.writeFileSync(files.report, reportOf(assessment));
  const body = planOf(assessment);
  let plan: string | null = null;
  if (body !== null) {
    plan = path.join(out, "plan.md");
    fs.writeFileSync(plan, body);
  }
  const { verdict, source, disposition } = assessment;
  console.log(
    JSON.stringify({
      verdict,
      disposition: disposition.kind,
      source,
      ...files,
      plan,
    }),
  );
}

function runApply(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: { config: { type: "string" }, issue: { type: "string" } },
  });
  const args = APPLY_ARGS.parse(values);
  const config = path.resolve(args.config);
  const { issue, branch, marker } = admit(loadConfig(config), args.issue);
  console.log(
    JSON.stringify({
      issue,
      branch,
      ...marker,
      task: "implement",
      next: "A qualified human must apply start:implement to this issue. This assessment grants no execution permission.",
    }),
  );
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "assess") {
    runAssess(rest);
    return;
  }
  if (command === "apply") {
    runApply(rest);
    return;
  }
  throw new Error(
    "usage: standards-upgrade assess --config CONFIG --repo OWNER/REPO [--ref REF] [--npm-registry URL] [--pypi-index URL] [--python-tools FILE] [--static] --out DIR | apply --config CONFIG --issue N",
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(messageOf(error));
  process.exitCode = FAILED;
  if (error instanceof Refusal) {
    process.exitCode = REFUSED;
  }
}
