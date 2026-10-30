import ts from "typescript";
import type { Project } from "./project.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const RESERVED = new Set([
  "eval",
  "arguments",
  "undefined",
  "NaN",
  "Infinity",
  "globalThis",
]);
function nodesIn(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [node];
  node.forEachChild((child: ts.Node): void => {
    nodes.push(...nodesIn(child));
  });
  return nodes;
}

function qualifiedName(node: ts.Node): string {
  const names: string[] = [];
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (
      (ts.isVariableDeclaration(current) ||
        ts.isParameter(current) ||
        ts.isFunctionDeclaration(current) ||
        ts.isClassDeclaration(current) ||
        ts.isTypeAliasDeclaration(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isPropertyDeclaration(current) ||
        ts.isPropertySignature(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isMethodSignature(current) ||
        ts.isGetAccessorDeclaration(current) ||
        ts.isSetAccessorDeclaration(current)) &&
      current.name !== undefined &&
      ts.isIdentifier(current.name)
    ) {
      names.unshift(current.name.text);
    }
    current = current.parent;
  }
  return names.join(".");
}

function targetsIn(source: ts.SourceFile): ts.Node[] {
  return nodesIn(source).filter(
    (node: ts.Node): boolean =>
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node),
  );
}

function targetOf(source: ts.SourceFile, symbol: string): ts.Node {
  const found = targetsIn(source).filter(
    (node) => qualifiedName(node) === symbol,
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(
      "target must identify exactly one declaration; inspect qualified names",
    );
  }
  return found[0];
}

function unusedName(project: Project, name: string): void {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    name,
  );
  if (
    !IDENTIFIER.test(name) ||
    RESERVED.has(name) ||
    scanner.scan() !== ts.SyntaxKind.Identifier ||
    scanner.scan() !== ts.SyntaxKind.EndOfFileToken
  ) {
    throw new Error("expected a non-reserved identifier");
  }
  for (const source of project.service.getProgram()?.getSourceFiles() ?? []) {
    if (
      !source.isDeclarationFile &&
      nodesIn(source).some(
        (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === name,
      )
    ) {
      throw new Error(
        "new name already occurs in the project; capture is unsupported",
      );
    }
  }
}

function applyEdits(
  project: Project,
  edits: readonly ts.FileTextChanges[],
): void {
  for (const edit of edits) {
    const before = project.texts.get(edit.fileName);
    if (before === undefined || edit.isNewFile === true) {
      throw new Error("library edit escapes assigned existing source files");
    }
    let text = before;
    let boundary = text.length;
    const ordered = [...edit.textChanges].sort(
      (a, b) => b.span.start - a.span.start,
    );
    for (const change of ordered) {
      const { start, length } = change.span;
      if (start < 0 || start + length > boundary) {
        throw new Error("invalid or overlapping library edits");
      }
      text = text.slice(0, start) + change.newText + text.slice(start + length);
      boundary = start;
    }
    project.replace(edit.fileName, text);
  }
}

export { applyEdits, nodesIn, qualifiedName, targetOf, targetsIn, unusedName };
