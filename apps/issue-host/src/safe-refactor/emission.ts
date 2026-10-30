import path from "node:path";
import ts from "typescript";
import type { Project } from "./project.ts";

const JAVASCRIPT_OUTPUT = /\.[cm]?jsx?$/u;
const JAVASCRIPT_INPUT = /\.[cm]?js$/u;
const PRINTER = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

// Probe the whole project, not just the edited file: types can affect value
// imports, const-enum consumers and decorator metadata elsewhere. All output
// stays in memory. Runtime compiler settings remain the project's own.
function javascriptOf(project: Project): ReadonlyMap<string, string> {
  const current = project.service.getProgram();
  if (current === undefined) {
    throw new Error("cannot establish JavaScript emission");
  }
  const options: ts.CompilerOptions = {
    ...project.options,
    noEmit: false,
    noEmitOnError: false,
    emitDeclarationOnly: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    inlineSources: false,
    incremental: false,
    composite: false,
    removeComments: true,
    outDir: path.join(project.root, ".refactor-emission"),
  };
  const host = ts.createCompilerHost(options);
  function textOf(file: string): string | undefined {
    const absolute = path.resolve(file);
    return (
      project.texts.get(absolute) ??
      project.inputs.get(absolute) ??
      current?.getSourceFile(absolute)?.text
    );
  }
  host.readFile = textOf;
  host.fileExists = (file: string): boolean => textOf(file) !== undefined;
  host.getSourceFile = (
    file: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  ): ts.SourceFile | undefined => {
    const text = textOf(file);
    if (text === undefined) {
      return undefined;
    }
    let kind = ts.ScriptKind.TS;
    if (file.endsWith(".tsx")) {
      kind = ts.ScriptKind.TSX;
    } else if (file.endsWith(".jsx")) {
      kind = ts.ScriptKind.JSX;
    } else if (JAVASCRIPT_INPUT.test(file)) {
      kind = ts.ScriptKind.JS;
    } else if (file.endsWith(".json")) {
      kind = ts.ScriptKind.JSON;
    }
    return ts.createSourceFile(file, text, languageVersion, true, kind);
  };
  const output = new Map<string, string>();
  host.writeFile = (file: string, data: string): void => {
    if (output.has(file)) {
      throw new Error("ambiguous JavaScript emission output");
    }
    let text = data;
    if (JAVASCRIPT_OUTPUT.test(file)) {
      let kind = ts.ScriptKind.JS;
      if (file.endsWith(".jsx")) {
        kind = ts.ScriptKind.JSX;
      }
      // Canonical JS parsing preserves automatic-semicolon semantics while
      // ignoring comments and whitespace moved by an erased type declaration.
      text = PRINTER.printFile(
        ts.createSourceFile(file, data, ts.ScriptTarget.Latest, true, kind),
      );
    }
    output.set(file, text);
  };
  const program = ts.createProgram({
    rootNames: current.getRootFileNames(),
    options,
    host,
  });
  const files = new Set(
    current.getSourceFiles().map((source) => source.fileName),
  );
  const projected = program.getSourceFiles();
  // The probe must resolve the same graph as the checked language-service
  // project. Unresolved imports can otherwise silently become `any` and mask
  // a real decorator-metadata or value-import change.
  if (
    projected.length !== files.size ||
    projected.some((source) => !files.has(source.fileName)) ||
    program.getSyntacticDiagnostics().length > 0 ||
    program.getSemanticDiagnostics().length > 0
  ) {
    throw new Error(
      "JavaScript emission cannot reproduce the checked project; defer this type edit",
    );
  }
  const result = program.emit();
  if (
    result.emitSkipped ||
    result.diagnostics.length > 0 ||
    ![...output.keys()].some((file) => JAVASCRIPT_OUTPUT.test(file))
  ) {
    throw new Error(
      "JavaScript emission evidence is unavailable; defer this type edit",
    );
  }
  return output;
}

function sameJavascript(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): boolean {
  return (
    before.size === after.size &&
    [...before].every(([file, text]) => after.get(file) === text)
  );
}

export { javascriptOf, sameJavascript };
