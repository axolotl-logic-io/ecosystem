#!/usr/bin/env node

// The repository standards upgrade's entrypoint (#129,
// docs/reference/standards-upgrade.md). build.ts bundles it as
// dist/standards-upgrade.mjs; nothing installs or schedules it.
//
//   node standards-upgrade.mjs assess --config CONFIG --repo OWNER/REPO|URL
//        [--ref REF] --out DIR
//
// `assess` reads the configured repository at REF (its default branch when
// omitted), resolved to one commit, and writes assessment.json, report.md
// and, when an upgrade has something to change, plan.md into DIR, an
// existing empty folder. It writes nothing to GitHub or the origin and runs
// no repository code. It prints one JSON line naming the verdict and the
// files. A wrong repository, an unreadable one or a ref that names no commit
// exits 2 with the reason on stderr, before anything is written; other
// errors exit 1.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { assess } from "../src/standards/assess.ts";
import { planOf, reportOf } from "../src/standards/report.ts";
import { Refusal } from "../src/standards/source.ts";

const FAILED = 1;
const REFUSED = 2;
const ASSESS_ARGS = z.object({
  config: z.string().min(1),
  repo: z.string().min(1),
  ref: z.string().optional(),
  out: z.string().min(1),
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
    },
  });
  const args = ASSESS_ARGS.parse(values);
  const out = emptyFolder(args.out);
  const assessment = assess(
    loadConfig(args.config),
    args.repo,
    args.ref ?? null,
    new Date(),
  );
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

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "assess") {
    throw new Error(
      "usage: standards-upgrade assess --config CONFIG --repo OWNER/REPO [--ref REF] --out DIR",
    );
  }
  runAssess(rest);
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
