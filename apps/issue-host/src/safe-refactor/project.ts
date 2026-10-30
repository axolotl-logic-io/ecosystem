import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import type { Assignment } from "./protocol.ts";

const CONFIG_EXTENDS = z.looseObject({
  extends: z
    .union([z.string(), z.array(z.string())])
    .nullish()
    .transform((value) => {
      if (typeof value === "string") {
        return [value];
      }
      return value ?? [];
    }),
});
const POLICY_NAMES = [
  "**/biome.json",
  "**/biome.jsonc",
  "**/.gitignore",
  "**/.ignore",
];
const POLICY_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.pi/**",
  "**/.claude/**",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.config/**",
];

function policiesIn(root: string): string[] {
  return fs
    .globSync(POLICY_NAMES, { cwd: root, exclude: POLICY_EXCLUDES })
    .sort();
}

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;
const PROTECTED_PART =
  /^(?:node_modules|\.git|\.env.*|\.pi|\.claude|\.ssh|\.aws|\.config|dist|coverage)$/iu;
const SENSITIVE_PART =
  /^(?:\.git|\.env.*|\.pi|\.claude|\.ssh|\.aws|\.config)$/iu;
const ENV_FILE = /^\.env/iu;
const MAX_FILE_BYTES = 1_048_576;
const MAX_COMPILER_INPUT_BYTES = 4_194_304;
const PATH_SEPARATOR = /[\\/]/u;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Refuse symlinks in every component, hard links and non-UTF-8 input. The
// caller must exclusively allocate this checkout; this is not an OS sandbox.
function plainFile(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.startsWith("-")) {
    throw new Error("expected a relative project path");
  }
  const parts = relative.split(PATH_SEPARATOR);
  if (parts.some((part) => part === ".." || PROTECTED_PART.test(part))) {
    throw new Error("protected or escaping project path");
  }
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error("symlink project paths are unsupported");
    }
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) {
    throw new Error("expected a bounded, unlinked plain file");
  }
  return current;
}

function readText(file: string, maximumBytes = MAX_FILE_BYTES): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maximumBytes) {
    throw new Error("expected a bounded text file");
  }
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || text.includes("\0")) {
    throw new Error("source must be UTF-8 text without NUL");
  }
  return text;
}

function compilerFile(
  root: string,
  compilerDirectory: string,
  file: string,
): string {
  const absolute = path.resolve(file);
  const local = absolute.startsWith(`${root}${path.sep}`);
  const compiler = absolute.startsWith(`${compilerDirectory}${path.sep}`);
  let relative = absolute;
  if (local) {
    relative = path.relative(root, absolute);
  }
  if (
    ENV_FILE.test(path.basename(absolute)) ||
    (!compiler &&
      relative.split(PATH_SEPARATOR).some((part) => SENSITIVE_PART.test(part)))
  ) {
    throw new Error("protected compiler input; defer this project");
  }
  if (
    !(
      local ||
      compiler ||
      absolute.split(PATH_SEPARATOR).includes("node_modules")
    )
  ) {
    throw new Error(
      `external non-package compiler input is unsupported: ${file}`,
    );
  }
  if (
    fs.realpathSync(absolute) !== absolute ||
    fs.statSync(absolute).nlink !== 1
  ) {
    throw new Error(
      "compiler inputs must be canonical singly-linked files; defer symlinked workspace/package adapters",
    );
  }
  return absolute;
}

interface Project {
  root: string;
  options: ts.CompilerOptions;
  texts: Map<string, string>;
  inputs: Map<string, string>;
  service: ts.LanguageService;
  source: (relative: string) => ts.SourceFile;
  read: (relative: string) => string;
  diagnostics: () => ts.Diagnostic[];
  assertFresh: () => void;
  replace: (file: string, text: string) => void;
  dispose: () => void;
}

function projectOf(assignment: Assignment): Project {
  const root = fs.realpathSync(assignment.root);
  if (!path.isAbsolute(assignment.root) || root !== assignment.root) {
    throw new Error("root must be a canonical absolute path");
  }
  const configFile = plainFile(root, assignment.project);
  const texts = new Map<string, string>();
  const inputs = new Map<string, string>();
  const existence = new Map<string, boolean>();
  const compilerDirectory = path.dirname(
    path.dirname(ts.getDefaultLibFilePath({})),
  );
  function inputText(file: string): string | undefined {
    const absolute = path.resolve(root, file);
    if (!ts.sys.fileExists(absolute)) {
      existence.set(absolute, false);
      return undefined;
    }
    compilerFile(root, compilerDirectory, absolute);
    const previous = texts.get(absolute) ?? inputs.get(absolute);
    if (previous !== undefined) {
      return previous;
    }
    const text = readText(absolute, MAX_COMPILER_INPUT_BYTES);
    inputs.set(absolute, text);
    return text;
  }
  function fileExists(file: string): boolean {
    const absolute = path.resolve(root, file);
    const exists = ts.sys.fileExists(absolute);
    existence.set(absolute, exists);
    return exists;
  }
  if (fileExists(path.join(root, "GLOSSARY.md"))) {
    inputText(plainFile(root, "GLOSSARY.md"));
  }
  const policies = policiesIn(root);
  const visited = new Set<string>();
  function policyInput(relative: string): void {
    const file = plainFile(root, relative);
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    const text = inputText(file);
    if (text === undefined || relative.endsWith("ignore")) {
      return;
    }
    const configuration = CONFIG_EXTENDS.parse(
      ts.parseConfigFileTextToJson(file, text).config,
    );
    for (const extension of configuration.extends.filter(
      (entry) => entry !== "//",
    )) {
      if (!extension.startsWith(".")) {
        throw new Error(
          "package/external Biome configuration requires a separate adapter",
        );
      }
      policyInput(
        path.relative(root, path.resolve(path.dirname(file), extension)),
      );
    }
  }
  for (const policy of [...policies, assignment.profile]) {
    policyInput(policy);
  }
  const configHost = { ...ts.sys, readFile: inputText, fileExists };
  const config = ts.readConfigFile(configFile, inputText);
  if (config.error !== undefined) {
    throw new Error("cannot read TypeScript project configuration");
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    configHost,
    path.dirname(configFile),
    { noEmit: true, allowJs: true, checkJs: true },
    configFile,
  );
  if (parsed.projectReferences !== undefined) {
    throw new Error(
      "project references require a separate check adapter; defer this project",
    );
  }
  if (parsed.errors.length > 0) {
    throw new Error("invalid TypeScript project configuration");
  }
  for (const relative of assignment.files) {
    if (!SOURCE_EXTENSION.test(relative) || DECLARATION_FILE.test(relative)) {
      throw new Error(
        "only JavaScript/TypeScript implementation files may change",
      );
    }
    const file = plainFile(root, relative);
    if (!parsed.fileNames.includes(file) || texts.has(file)) {
      throw new Error("write scope must contain unique project source files");
    }
    texts.set(file, readText(file));
  }
  const versions = new Map<string, number>();
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: (): ts.CompilerOptions => parsed.options,
    getScriptFileNames: (): string[] => parsed.fileNames,
    getScriptVersion: (file: string): string => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file: string): ts.IScriptSnapshot | undefined => {
      let text = texts.get(file);
      text ??= inputText(file);
      if (text === undefined) {
        return undefined;
      }
      return ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: (): string => root,
    getDefaultLibFileName: (options: ts.CompilerOptions): string =>
      ts.getDefaultLibFilePath(options),
    fileExists,
    readFile: inputText,
    readDirectory: ts.sys.readDirectory,
  };
  const service = ts.createLanguageService(host);
  function read(relative: string): string {
    const file = plainFile(root, relative);
    const text = texts.get(file);
    if (text === undefined) {
      throw new Error("target is outside assigned write scope");
    }
    return text;
  }
  function diagnostics(): ts.Diagnostic[] {
    const program = service.getProgram();
    if (program === undefined) {
      throw new Error("language service has no project");
    }
    return [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
  }
  return {
    root,
    options: parsed.options,
    texts,
    inputs,
    service,
    read,
    diagnostics,
    source: (relative: string): ts.SourceFile => {
      read(relative);
      const file = service
        .getProgram()
        ?.getSourceFile(path.join(root, relative));
      if (file === undefined) {
        throw new Error("target is not in the language-service project");
      }
      return file;
    },
    assertFresh: (): void => {
      if (JSON.stringify(policiesIn(root)) !== JSON.stringify(policies)) {
        throw new Error("lint configuration set changed; request a new run");
      }
      for (const [file, text] of inputs) {
        if (
          readText(
            compilerFile(root, compilerDirectory, file),
            MAX_COMPILER_INPUT_BYTES,
          ) !== text
        ) {
          throw new Error("project input changed; request a new run");
        }
      }
      for (const [file, exists] of existence) {
        if (ts.sys.fileExists(file) !== exists) {
          throw new Error("project file set changed; request a new run");
        }
      }
      const current = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configFile),
        { noEmit: true, allowJs: true, checkJs: true },
        configFile,
      );
      if (
        JSON.stringify(current.fileNames) !== JSON.stringify(parsed.fileNames)
      ) {
        throw new Error("project file set changed; request a new run");
      }
      for (const [file, text] of texts) {
        if (readText(plainFile(root, path.relative(root, file))) !== text) {
          throw new Error(
            "source changed outside this run; reconcile before writing",
          );
        }
      }
    },
    replace: (file: string, text: string): void => {
      if (!texts.has(file)) {
        throw new Error("library edit is outside assigned write scope");
      }
      if (
        Buffer.byteLength(text) > MAX_FILE_BYTES ||
        text.includes("\0") ||
        Buffer.from(text).toString("utf8") !== text
      ) {
        throw new Error("edited source must remain bounded UTF-8 without NUL");
      }
      texts.set(file, text);
      versions.set(file, (versions.get(file) ?? 0) + 1);
    },
    dispose: (): void => service.dispose(),
  };
}

export type { Project };
export { digest, plainFile, projectOf, readText };
