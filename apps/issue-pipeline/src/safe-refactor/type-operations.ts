import ts from "typescript";
import type { Project } from "./project.ts";
import type { Operation } from "./protocol.ts";
import { applyEdits, targetOf, unusedName } from "./syntax.ts";

type TypeOperation = Extract<
  Operation,
  {
    operation:
      | "introduce-type"
      | "modify-type"
      | "remove-type"
      | "set-type-annotation"
      | "remove-type-annotation";
  }
>;
type NamedType = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
type Annotated =
  | ts.VariableDeclaration
  | ts.ParameterDeclaration
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.MethodSignature
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

const PRINTER = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const CHECK_DIRECTIVE = /@ts-(?:ignore|nocheck|expect-error)\b/u;
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/u;
const FRAGMENT_NAME = "__RefactorType";

// Type text is not replacement source. Reject extra statements and comments,
// including compiler directives, before printing a single accepted type node.
function parsed(text: string): ts.SourceFile {
  if (text.includes("\0") || Buffer.from(text).toString("utf8") !== text) {
    throw new Error("type syntax must be valid UTF-8 without NUL");
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia ||
      token === ts.SyntaxKind.ShebangTrivia
    ) {
      throw new Error(
        "comments and directives are not accepted as type syntax",
      );
    }
    token = scanner.scan();
  }
  const result = ts.transpileModule(text, {
    fileName: "refactor-type.ts",
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  });
  if (
    result.diagnostics?.some(
      (entry) => entry.category === ts.DiagnosticCategory.Error,
    )
  ) {
    throw new Error("invalid type syntax");
  }
  return ts.createSourceFile(
    "refactor-type.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function declaration(text: string, name: string): string {
  const source = parsed(text);
  const [node] = source.statements;
  if (
    source.statements.length !== 1 ||
    node === undefined ||
    !(ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) ||
    node.name.text !== name
  ) {
    throw new Error(
      "supply exactly one alias or interface with the requested name",
    );
  }
  return PRINTER.printNode(ts.EmitHint.Unspecified, node, source);
}

function typeText(text: string, returns: boolean): string {
  let syntax = text;
  if (returns) {
    syntax = `() => ${text}`;
  }
  const source = parsed(`type ${FRAGMENT_NAME} = ${syntax};`);
  const [node] = source.statements;
  if (
    source.statements.length !== 1 ||
    node === undefined ||
    !ts.isTypeAliasDeclaration(node) ||
    node.name.text !== FRAGMENT_NAME
  ) {
    throw new Error("supply exactly one type expression");
  }
  let { type } = node;
  if (returns) {
    if (!ts.isFunctionTypeNode(type)) {
      throw new Error("supply exactly one return type");
    }
    ({ type } = type);
  }
  return PRINTER.printNode(ts.EmitHint.Unspecified, type, source);
}

function annotated(node: ts.Node): Annotated {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node;
  }
  throw new Error("target has no supported type annotation");
}

function annotationTarget(
  node: ts.Node,
  slot: "annotation" | "return",
): Annotated {
  if (
    slot === "return" &&
    (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
  ) {
    const { initializer } = node;
    if (
      initializer !== undefined &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      return initializer;
    }
    throw new Error("return slot requires a function initializer");
  }
  const target = annotated(node);
  if (slot === "return" && !ts.isFunctionLike(target)) {
    throw new Error("return slot requires a function or method");
  }
  return target;
}

function annotationEdit(
  source: ts.SourceFile,
  symbol: string,
  slot: "annotation" | "return",
  text: string | null,
): ts.TextChange {
  const node = annotationTarget(targetOf(source, symbol), slot);
  if (node.type !== undefined) {
    if (text !== null) {
      return {
        span: {
          start: node.type.getStart(source),
          length: node.type.end - node.type.getStart(source),
        },
        newText: typeText(text, ts.isFunctionLike(node)),
      };
    }
    const colon = node
      .getChildren(source)
      .find((child) => child.kind === ts.SyntaxKind.ColonToken);
    if (colon === undefined) {
      throw new Error("cannot establish the annotation boundary");
    }
    return {
      span: {
        start: colon.getStart(source),
        length: node.type.end - colon.getStart(source),
      },
      newText: "",
    };
  }
  if (text === null) {
    throw new Error("target has no annotation to remove");
  }
  let position: number;
  if (ts.isFunctionLike(node)) {
    const close = node
      .getChildren(source)
      .find((child) => child.kind === ts.SyntaxKind.CloseParenToken);
    if (close === undefined) {
      throw new Error(
        "return annotation requires an existing parenthesized parameter list",
      );
    }
    position = close.end;
  } else {
    position = node.name.end;
    if (!ts.isVariableDeclaration(node)) {
      position = node.questionToken?.end ?? position;
    }
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
      position = node.exclamationToken?.end ?? position;
    }
  }
  return {
    span: { start: position, length: 0 },
    newText: `: ${typeText(text, ts.isFunctionLike(node))}`,
  };
}

function namedTarget(source: ts.SourceFile, symbol: string): NamedType {
  const node = targetOf(source, symbol);
  if (!(ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node))) {
    throw new Error("target must identify an alias or interface");
  }
  return node;
}

function changeTypes(project: Project, operation: TypeOperation): void {
  const source = project.source(operation.target.file);
  if (!TYPESCRIPT_FILE.test(source.fileName) || source.isDeclarationFile) {
    throw new Error("type operations require a TypeScript implementation file");
  }
  if (CHECK_DIRECTIVE.test(source.text)) {
    throw new Error(
      "type operations refuse source with typecheck suppression directives",
    );
  }
  const edits: ts.TextChange[] = [];
  if (
    operation.operation === "set-type-annotation" ||
    operation.operation === "remove-type-annotation"
  ) {
    let text: string | null = null;
    if (operation.operation === "set-type-annotation") {
      text = operation.type;
    }
    edits.push(
      annotationEdit(source, operation.target.symbol, operation.slot, text),
    );
  } else {
    for (const annotation of operation.annotations) {
      edits.push(
        annotationEdit(
          source,
          annotation.symbol,
          annotation.slot,
          annotation.type,
        ),
      );
    }
    if (operation.operation === "introduce-type") {
      unusedName(project, operation.target.symbol);
      edits.push({
        span: { start: source.end, length: 0 },
        newText: `\n${declaration(operation.declaration, operation.target.symbol)}\n`,
      });
    } else {
      const target = namedTarget(source, operation.target.symbol);
      let text = "";
      if (operation.operation === "modify-type") {
        text = declaration(operation.declaration, target.name.text);
      }
      edits.push({
        span: {
          start: target.getStart(source),
          length: target.end - target.getStart(source),
        },
        newText: text,
      });
    }
  }
  applyEdits(project, [{ fileName: source.fileName, textChanges: edits }]);
}

export type { TypeOperation };
export { changeTypes };
