import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { childEnvironment } from "@ecosystem/task-runtime/child-env";
import { runRpc } from "@ecosystem/task-runtime/job/rpc";
import { queryOf } from "../job/git-review-policy.ts";
import { executeGit } from "../job/git-review-process.ts";
import { repositoryOf } from "../job/git-review-repository.ts";
import { runtimeProfile } from "../job/runtime-profile.ts";
import { type CheckEvidence, check, evidencePage } from "./check.ts";
import { engineOf, save } from "./engine.ts";
import { digest, plainFile, projectOf, readText } from "./project.ts";
import {
  ASSIGNMENT,
  type Assignment,
  REPORT,
  type Report,
} from "./protocol.ts";

interface CheckComparison {
  name: string;
  baseline: string;
  after: string;
  baselineDiagnostics: number;
  afterDiagnostics: number | null;
  regression: "observed" | "not-observed" | "unknown";
}

function compare(
  baseline: CheckEvidence,
  after: CheckEvidence,
): CheckComparison[] {
  return baseline.checks.map(
    (before: CheckEvidence["checks"][number]): CheckComparison => {
      const current = after.checks.find((entry) => entry.name === before.name);
      let regression: CheckComparison["regression"] = "unknown";
      if (current?.verdict === "passed") {
        regression = "not-observed";
      } else if (before.verdict === "passed" && current?.verdict === "failed") {
        regression = "observed";
      }
      return {
        name: before.name,
        baseline: before.verdict,
        after: current?.verdict ?? "unknown",
        baselineDiagnostics: before.diagnostics.length,
        afterDiagnostics: current?.diagnostics.length ?? null,
        regression,
      };
    },
  );
}

interface TaskReport {
  run: string;
  task: string;
  outcome: "reported" | "held";
  runState: "ended" | "stopped";
  directory: string;
  revision: string;
  baseline: CheckEvidence;
  after: CheckEvidence;
  comparison: CheckComparison[];
  inputIdentityMatched: boolean;
  proposal: Report | null;
  needsHardening: boolean;
  deliveryAuthority: boolean;
}

const SHA256_LENGTH = 64;
const TREE_ENTRY =
  /^[0-7]{6} blob (?<object>[a-f0-9]{40}|[a-f0-9]{64})\t(?<file>[^\t\r\n]+)$/u;
const SESSION_TIMEOUT_MS = 3_600_000;
const SYSTEM_PROMPT =
  "You are performing the Safe Refactor task. Read AGENTS.md and referenced practices through safe_refactor read. Choose coherent design improvements using the requirements, glossary and check findings. The caller selected js-values-effects-v1; code relying on source/name/stack reflection or timing/resource details is unsupported. Defer requests relying on those observations. Do not hide findings with suppressions, raised thresholds, arbitrary splits, forwarding wrappers or relocated complexity. Use safe_refactor to inspect, check and request named operations. Type operations accept only aliases, interfaces and annotations, not runtime declarations. Introduce a top-level named type and its selected annotation uses atomically when strict unused-type checks require it. Type edits must keep emitted JavaScript unchanged; external TypeScript API compatibility still needs independent review. Findings are design signals, not a demand for a clean score. Explain deferred findings. Finish with safe_refactor_finish. Your report is a proposal, not a Hardening, Security or Land result.";

async function exactSource(assignment: Assignment): Promise<void> {
  const root = repositoryOf(assignment.root, [assignment.root]);
  const head = await executeGit(
    root,
    queryOf(["rev-parse", "--verify", "HEAD"]),
  );
  const status = await executeGit(
    root,
    queryOf(["status", "--porcelain", "--untracked-files=all"]),
  );
  if (
    head.exitCode !== 0 ||
    head.output.trim() !== assignment.revision ||
    status.exitCode !== 0 ||
    status.output !== ""
  ) {
    throw new Error(
      "task requires a clean checkout at the assigned exact revision; preserve existing work",
    );
  }
  const tree = await executeGit(
    root,
    queryOf(["ls-tree", "-r", "--full-tree", assignment.revision]),
  );
  if (tree.exitCode !== 0) {
    throw new Error("cannot establish the assigned source tree");
  }
  const entries = new Map<string, string>();
  for (const line of tree.output.split("\n")) {
    const match = TREE_ENTRY.exec(line);
    if (match?.groups !== undefined) {
      const { object, file } = match.groups;
      if (object !== undefined && file !== undefined) {
        entries.set(file, object);
      }
    }
  }
  let algorithm = "sha1";
  if (assignment.revision.length === SHA256_LENGTH) {
    algorithm = "sha256";
  }
  const project = projectOf(assignment);
  try {
    project.diagnostics();
    const files = new Set([...project.texts.keys(), ...project.inputs.keys()]);
    files.add(path.join(root, "GLOSSARY.md"));
    const localFiles = [...files].filter(
      (file) =>
        file.startsWith(`${root}${path.sep}`) &&
        !path.relative(root, file).split(path.sep).includes("node_modules"),
    );
    for (const file of localFiles) {
      const relative = path.relative(root, file);
      const bytes = Buffer.from(readText(plainFile(root, relative)));
      const actual = createHash(algorithm)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (entries.get(relative) !== actual) {
        throw new Error(
          "source/config/glossary is not bound to the assigned exact revision",
        );
      }
    }
    project.assertFresh();
  } finally {
    project.dispose();
  }
}

function taskArgs(
  assignment: Assignment,
  directory: string,
  extension: string,
): string[] {
  return [
    "--mode",
    "rpc",
    "--print",
    "--offline",
    "--no-approve",
    "--no-extensions",
    "-nc",
    "-ns",
    "-np",
    "--no-themes",
    "--tools",
    "safe_refactor,safe_refactor_finish",
    "--model",
    assignment.model,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--session",
    path.join(directory, "session.jsonl"),
    "-e",
    extension,
  ];
}

function proposalOf(file: string): Report | null {
  if (fs.existsSync(file)) {
    return REPORT.parse(JSON.parse(readText(file)));
  }
  return null;
}

// A standalone, explicitly assigned task with no scheduler. Artifacts here
// never write workflow state or grant authority.
async function runTask(
  input: unknown,
  artifacts: string,
  extension: string,
): Promise<TaskReport> {
  const assignment = ASSIGNMENT.parse(input);
  await exactSource(assignment);
  const parent = fs.realpathSync(artifacts);
  const root = fs.realpathSync(assignment.root);
  if (parent === root || parent.startsWith(`${root}${path.sep}`)) {
    throw new Error("artifacts must be outside the project");
  }
  const run = randomUUID();
  const directory = path.join(parent, run);
  fs.mkdirSync(directory, { mode: 0o700 });
  save(directory, "assignment.json", assignment);
  const engine = engineOf(assignment, directory);
  const { baseline } = engine;
  engine.dispose();
  save(directory, "baseline.json", baseline);
  const glossary = readText(plainFile(root, "GLOSSARY.md"));
  save(directory, "provenance.json", {
    run,
    task: "Safe Refactor",
    buddy: "Hippy",
    revision: assignment.revision,
    policy: assignment.policy,
    glossary: digest(glossary),
    behavior: assignment.behavior,
    systemPrompt: digest(SYSTEM_PROMPT),
  });
  const session = path.join(directory, "session.jsonl");
  const runtime = runtimeProfile({
    model: assignment.model,
    runtime: assignment.runtime,
    cwd: root,
    session,
    env: Object.fromEntries([
      ...Object.entries(childEnvironment(process.env)),
      ["SAFE_REFACTOR_RUN", directory],
    ]),
  });
  if ("error" in runtime) {
    save(directory, "outcome.json", {
      outcome: "refused",
      error: runtime.error,
    });
    throw new Error(`${runtime.error}; artifacts retained at ${directory}`);
  }
  const args = taskArgs(assignment, directory, extension);
  args.push("-e", runtime.extension);
  const exit = await runRpc({
    args,
    cwd: root,
    env: runtime.env,
    prompt: `${assignment.prompt}\n\nRequirements:\n${assignment.requirements}\n\nDomain glossary:\n${glossary}\n\nAssigned files:\n${assignment.files.join("\n")}\n\nBaseline (first JSON page; use check with baseline:true and offset/limit for remaining characters):\n${JSON.stringify(evidencePage(baseline))}`,
    timeoutMs: SESSION_TIMEOUT_MS,
    preflight: {
      policy: runtime.policy,
      endpoint: runtime.endpoint,
      provenance: runtime.provenance,
      verify: runtime.verify,
    },
    onSpawn: (): void => undefined,
    onRecord: (record: unknown): void => {
      fs.appendFileSync(
        path.join(directory, "events.jsonl"),
        `${JSON.stringify(record)}\n`,
        { mode: 0o600 },
      );
    },
  });
  save(directory, "session-exit.json", exit);
  const project = projectOf(assignment);
  try {
    const after = check(project, assignment);
    save(directory, "after.json", after);
    const proposal = proposalOf(path.join(directory, "proposal.json"));
    const held = fs.existsSync(path.join(directory, "pending.json"));
    const inputIdentityMatched =
      JSON.stringify(Object.entries(baseline.inputs).sort()) ===
        JSON.stringify(Object.entries(after.inputs).sort()) &&
      JSON.stringify(baseline.checker) === JSON.stringify(after.checker);
    const valid =
      inputIdentityMatched &&
      baseline.checks.every((entry) => entry.verdict !== "unknown") &&
      exit.code === 0 &&
      !exit.timedOut &&
      proposal !== null &&
      !held &&
      after.checks.every(
        (entry) =>
          entry.verdict === "passed" ||
          (entry.name === "metrics" && entry.verdict === "failed"),
      );
    let runState: TaskReport["runState"] = "stopped";
    let outcome: TaskReport["outcome"] = "held";
    if (valid) {
      runState = "ended";
      outcome = "reported";
    }
    const result: TaskReport = {
      run,
      task: "Safe Refactor",
      outcome,
      runState,
      directory,
      revision: assignment.revision,
      baseline,
      after,
      comparison: compare(baseline, after),
      inputIdentityMatched,
      proposal,
      needsHardening: true,
      deliveryAuthority: false,
    };
    save(directory, "outcome.json", result);
    return result;
  } finally {
    project.dispose();
  }
}

export { exactSource, runTask, taskArgs };
