import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type CheckEvidence, check, evidencePage } from "./check.ts";
import { inspect, transform } from "./operations.ts";
import {
  digest,
  type Project,
  plainFile,
  projectOf,
  readText,
} from "./project.ts";
import {
  ASSIGNMENT,
  type Assignment,
  OPERATION,
  type Operation,
} from "./protocol.ts";

const PRIVATE_FILE_MODE = 0o600;
const READABLE_EXTENSION = /\.(?:[cm]?[jt]sx?|md|jsonc?|toml)$/u;

interface Edit {
  file: string;
  before: string;
  after: string;
}

interface Engine {
  assignment: Assignment;
  baseline: CheckEvidence;
  execute: (input: unknown) => unknown;
  check: () => CheckEvidence;
  dispose: () => void;
}

function save(directory: string, name: string, value: unknown): void {
  const fd = fs.openSync(path.join(directory, name), "wx", PRIVATE_FILE_MODE);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(directory);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// A write-ahead checkpoint survives interrupted/partial writes. A pending
// checkpoint is a hold, never an invitation to replay the operation.
function apply(
  assignment: Assignment,
  directory: string,
  operation: Operation,
  edits: readonly Edit[],
): string {
  const pending = path.join(directory, "pending.json");
  if (fs.existsSync(pending)) {
    throw new Error(
      "uncertain prior write: inspect pending.json and reconcile; do not repeat",
    );
  }
  const descriptors: { fd: number; edit: Edit }[] = [];
  try {
    for (const edit of edits) {
      const file = plainFile(
        assignment.root,
        path.relative(assignment.root, edit.file),
      );
      const fd = fs.openSync(file, "r+");
      descriptors.push({ fd, edit });
      const opened = fs.fstatSync(fd);
      const current = fs.lstatSync(
        plainFile(assignment.root, path.relative(assignment.root, file)),
      );
      if (
        opened.ino !== current.ino ||
        opened.dev !== current.dev ||
        opened.nlink !== 1 ||
        fs.readFileSync(fd, "utf8") !== edit.before
      ) {
        throw new Error("source changed before application");
      }
    }
    const id = randomUUID();
    save(directory, "pending.json", {
      id,
      root: assignment.root,
      revision: assignment.revision,
      policy: assignment.policy,
      operation,
      edits,
    });
    for (const { fd, edit } of descriptors) {
      const bytes = Buffer.from(edit.after);
      const written = fs.writeSync(fd, bytes, 0, bytes.length, 0);
      if (written !== bytes.length) {
        throw new Error(
          "short source write; pending checkpoint needs reconciliation",
        );
      }
      fs.ftruncateSync(fd, Buffer.byteLength(edit.after));
      fs.fsyncSync(fd);
    }
    const checkpoint = `${id}.applied.json`;
    fs.renameSync(pending, path.join(directory, checkpoint));
    syncDirectory(directory);
    return checkpoint;
  } finally {
    for (const { fd } of descriptors) {
      fs.closeSync(fd);
    }
  }
}

function mutation(
  project: Project,
  assignment: Assignment,
  directory: string,
  operation: Exclude<Operation, { operation: "inspect" | "check" | "read" }>,
): unknown {
  if (fs.existsSync(path.join(directory, "pending.json"))) {
    throw new Error("pending write needs read-only reconciliation");
  }
  project.assertFresh();
  if (digest(project.read(operation.target.file)) !== operation.source) {
    throw new Error("stale target source hash");
  }
  if (
    check(project, assignment).checks.some(
      (entry) =>
        entry.verdict === "unknown" ||
        (entry.name !== "metrics" && entry.verdict !== "passed"),
    )
  ) {
    throw new Error(
      "non-metric/type baseline is not clear; defer this refactor",
    );
  }
  const before = new Map(project.texts);
  let applied = false;
  try {
    transform(project, operation);
    if (project.diagnostics().length > 0) {
      throw new Error("refactoring introduces or retains type/syntax errors");
    }
    const edits: Edit[] = [];
    for (const [file, text] of project.texts) {
      const previous = before.get(file);
      if (previous !== undefined && previous !== text) {
        edits.push({ file, before: previous, after: text });
      }
    }
    if (edits.length === 0) {
      throw new Error("operation produced no edits");
    }
    // Return overlays to disk state for the final freshness check. The
    // application receives only engine-computed edits, never model text.
    for (const [file, text] of before) {
      project.replace(file, text);
    }
    project.assertFresh();
    const checkpoint = apply(assignment, directory, operation, edits);
    for (const edit of edits) {
      project.replace(edit.file, edit.after);
    }
    applied = true;
    const evidence = check(project, assignment);
    save(directory, `${checkpoint}.checks.json`, evidence);
    return {
      checkpoint,
      files: edits.map((edit) => ({
        file: path.relative(project.root, edit.file),
        before: digest(edit.before),
        after: digest(edit.after),
      })),
      evidence,
    };
  } finally {
    if (!applied) {
      for (const [file, text] of before) {
        project.replace(file, text);
      }
    }
  }
}

function engineOf(input: unknown, runDirectory: string): Engine {
  const assignment = ASSIGNMENT.parse(input);
  const project = projectOf(assignment);
  const directory = fs.realpathSync(runDirectory);
  if (
    directory === project.root ||
    directory.startsWith(`${project.root}${path.sep}`)
  ) {
    project.dispose();
    throw new Error("run artifacts must be outside the project");
  }
  if (fs.existsSync(path.join(directory, "pending.json"))) {
    project.dispose();
    throw new Error(
      "pending write requires read-only reconciliation, not a new engine",
    );
  }
  const baseline = check(project, assignment);
  return {
    assignment,
    baseline,
    check: (): CheckEvidence => check(project, assignment),
    execute: (inputOperation: unknown): unknown => {
      const operation = OPERATION.parse(inputOperation);
      if (operation.operation === "check") {
        let evidence = baseline;
        if (!operation.baseline) {
          evidence = check(project, assignment);
        }
        const artifact = `${randomUUID()}.check.json`;
        save(directory, artifact, evidence);
        return {
          ...evidencePage(evidence, operation.offset, operation.limit),
          artifact,
        };
      }
      if (operation.operation === "inspect") {
        project.assertFresh();
        return {
          ...inspect(
            project,
            operation.file,
            operation.offset,
            operation.limit,
          ),
          source: digest(project.read(operation.file)),
        };
      }
      if (operation.operation === "read") {
        if (!READABLE_EXTENSION.test(operation.file)) {
          throw new Error(
            "read supports only project source, Markdown and configuration text",
          );
        }
        const text = readText(plainFile(project.root, operation.file));
        return {
          file: operation.file,
          source: digest(text),
          offset: operation.offset,
          totalCharacters: text.length,
          text: text.slice(
            operation.offset,
            operation.offset + operation.limit,
          ),
        };
      }
      return mutation(project, assignment, directory, operation);
    },
    dispose: (): void => project.dispose(),
  };
}

export type { Engine };
export { engineOf, save };
