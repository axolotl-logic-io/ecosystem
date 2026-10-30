import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";
import { z } from "zod";
import type { Project } from "./project.ts";
import { digest, plainFile, readText } from "./project.ts";
import { type Assignment, DEFAULT_PAGE_CHARACTERS } from "./protocol.ts";

const METRICS = [
  "style/noExcessiveLinesPerFile",
  "complexity/noExcessiveLinesPerFunction",
  "complexity/noExcessiveCognitiveComplexity",
];
const BIOME_REPORT = z.looseObject({
  summary: z.looseObject({
    diagnosticsNotPrinted: z.literal(0),
    skipped: z.literal(0),
    changed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  diagnostics: z.array(
    z.looseObject({ category: z.string().nullable(), severity: z.string() }),
  ),
});
const CHECK_TIMEOUT_MS = 120_000;
const BIOME_VERSION = "2.5.15";
const VERSION_MAX_BYTES = 1024;
const MAX_OUTPUT_BYTES = 16_777_216;

interface CheckEvidence {
  behavior: Assignment["behavior"];
  profile: string;
  sources: Record<string, string>;
  inputs: Record<string, string>;
  backend: string;
  project: string;
  notRun: string[];
  checker: {
    launcher: string;
    source: string;
    version: string | null;
    node: string;
  };
  checks: {
    name: string;
    verdict: "passed" | "failed" | "unknown";
    diagnostics: unknown[];
    error: string | null;
  }[];
}

function biomeCheck(
  assignment: Assignment,
  metrics: boolean,
  version: string | null,
  targets?: readonly string[],
): CheckEvidence["checks"][number] {
  const args = [
    "check",
    "--reporter=json",
    "--max-diagnostics=none",
    "--error-on-warnings",
  ];
  let name = "default";
  if (metrics) {
    name = "metrics";
    args[0] = "lint";
    args.push("--config-path", plainFile(assignment.root, assignment.profile));
    args.push(...METRICS.map((rule) => `--only=${rule}`));
  }
  if (version !== BIOME_VERSION) {
    return {
      name,
      verdict: "unknown",
      diagnostics: [],
      error: "unsupported or unavailable Biome version; require 2.5.15",
    };
  }
  if (targets === undefined) {
    args.push("--", ".", ...assignment.files);
  } else {
    args.push("--", ...targets);
  }
  const result = spawnSync(process.execPath, [assignment.biome, ...args], {
    cwd: assignment.root,
    env: {},
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  let report: unknown = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  const parsed = BIOME_REPORT.safeParse(report);
  if (
    result.error !== undefined ||
    !parsed.success ||
    (targets !== undefined &&
      parsed.data.summary.changed + parsed.data.summary.unchanged !==
        targets.length) ||
    (result.status !== 0 && result.status !== 1) ||
    parsed.data.diagnostics.some(
      (entry) =>
        entry.severity === "fatal" ||
        entry.category?.startsWith("internalError") === true ||
        entry.category === "configuration",
    )
  ) {
    return {
      name,
      verdict: "unknown",
      diagnostics: [],
      error: "checker failed or returned incomplete/unreadable evidence",
    };
  }
  let verdict: "passed" | "failed" = "failed";
  if (result.status === 0) {
    verdict = "passed";
  }
  return {
    name,
    verdict,
    diagnostics: parsed.data.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      id: digest(JSON.stringify(diagnostic)),
    })),
    error: null,
  };
}

function versionOf(launcher: string): typeof BIOME_VERSION | null {
  const result = spawnSync(process.execPath, [launcher, "--version"], {
    env: {},
    encoding: "utf8",
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: VERSION_MAX_BYTES,
  });
  if (
    result.status === 0 &&
    result.stdout.trim() === `Version: ${BIOME_VERSION}`
  ) {
    return BIOME_VERSION;
  }
  return null;
}

function check(project: Project, assignment: Assignment): CheckEvidence {
  project.assertFresh();
  const profile = digest(readText(plainFile(project.root, assignment.profile)));
  if (profile !== assignment.policy) {
    throw new Error("check policy changed; request a new run");
  }
  if (
    !(
      path.isAbsolute(assignment.biome) &&
      fs.statSync(assignment.biome).isFile()
    )
  ) {
    throw new Error("caller must supply an absolute trusted Biome executable");
  }
  const version = versionOf(assignment.biome);
  const diagnostics = project.diagnostics().map((diagnostic) => ({
    code: diagnostic.code,
    file: diagnostic.file?.fileName ?? null,
    start: diagnostic.start ?? null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
  const checks: CheckEvidence["checks"] = [
    biomeCheck(assignment, false, version),
    biomeCheck(assignment, true, version),
    { name: "types", verdict: "passed", diagnostics, error: null },
  ];
  const [, , types] = checks;
  if (types !== undefined && diagnostics.length > 0) {
    types.verdict = "failed";
  }
  project.assertFresh();
  return {
    behavior: assignment.behavior,
    profile,
    backend: `typescript@${ts.version}`,
    project: assignment.project,
    notRun: ["build", "Hardening", "Security", "Land"],
    checker: {
      launcher: assignment.biome,
      source: digest(readText(assignment.biome)),
      version,
      node: process.version,
    },
    inputs: Object.fromEntries(
      [...project.inputs].map(([file, text]) => [file, digest(text)]),
    ),
    sources: Object.fromEntries(
      [...project.texts].map(([file, text]) => [
        path.relative(project.root, file),
        digest(text),
      ]),
    ),
    checks,
  };
}

interface EvidencePage {
  hash: string;
  offset: number;
  totalCharacters: number;
  text: string;
  checks: {
    name: string;
    verdict: CheckEvidence["checks"][number]["verdict"];
    diagnostics: number;
    error: string | null;
  }[];
  notRun: string[];
}

function evidencePage(
  evidence: CheckEvidence,
  offset = 0,
  limit = DEFAULT_PAGE_CHARACTERS,
): EvidencePage {
  const { checks, ...identity } = evidence;
  const text = JSON.stringify({ checks, ...identity });
  return {
    hash: digest(text),
    offset,
    totalCharacters: text.length,
    text: text.slice(offset, offset + limit),
    checks: checks.map((entry) => ({
      name: entry.name,
      verdict: entry.verdict,
      diagnostics: entry.diagnostics.length,
      error: entry.error,
    })),
    notRun: evidence.notRun,
  };
}

// The baseline already checked unchanged files. Format only projected type
// edits, without lint autofixes, then check each complete projected file
// under the same default policy before the engine opens a source descriptor.
function prepareTypeEdits(
  project: Project,
  assignment: Assignment,
  before: ReadonlyMap<string, string>,
  directory: string,
): void {
  const version = versionOf(assignment.biome);
  if (version !== BIOME_VERSION) {
    throw new Error("projected type edits require the trusted Biome version");
  }
  const changed = [...project.texts].filter(
    ([file, text]) => before.get(file) !== text,
  );
  for (const [file, text] of changed) {
    const relative = path.relative(project.root, file);
    const formatted = spawnSync(
      process.execPath,
      [assignment.biome, "format", "--stdin-file-path", relative],
      {
        cwd: assignment.root,
        env: {},
        encoding: "utf8",
        timeout: CHECK_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        input: text,
      },
    );
    if (formatted.error !== undefined || formatted.status !== 0) {
      throw new Error(
        "projected type formatting failed; no source was written",
      );
    }
    project.replace(file, formatted.stdout);
  }
  // Biome 2.5 stdin mode formats but does not provide complete lint evidence.
  // Check a private projection instead, with unchanged consulted policy and
  // source bytes plus the overlays; never accept an in-memory lint autofix.
  const projection = fs.mkdtempSync(path.join(directory, "projection-"));
  try {
    const inputs = new Map([...project.inputs, ...project.texts]);
    for (const [file, text] of inputs) {
      if (
        file.startsWith(`${project.root}${path.sep}`) &&
        !path
          .relative(project.root, file)
          .split(path.sep)
          .includes("node_modules")
      ) {
        const destination = path.join(
          projection,
          path.relative(project.root, file),
        );
        fs.mkdirSync(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(destination, text, { mode: 0o600 });
      }
    }
    const initialized = spawnSync(
      "/usr/bin/git",
      ["init", "--quiet", projection],
      { env: {}, encoding: "utf8", timeout: CHECK_TIMEOUT_MS },
    );
    if (initialized.error !== undefined || initialized.status !== 0) {
      throw new Error(
        "cannot establish projected checker scope; no source was written",
      );
    }
    for (const [file] of changed) {
      const relative = path.relative(project.root, file);
      const checked = biomeCheck(
        { ...assignment, root: projection },
        false,
        version,
        [relative],
      );
      if (checked.verdict !== "passed") {
        throw new Error(
          "projected type edits fail default Biome checks; no source was written",
        );
      }
    }
  } finally {
    fs.rmSync(projection, { recursive: true, force: true });
  }
}

export type { CheckEvidence };
export { check, evidencePage, METRICS, prepareTypeEdits };
