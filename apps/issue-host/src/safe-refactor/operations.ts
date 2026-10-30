import ts from "typescript";
import type { Project } from "./project.ts";
import type { Operation } from "./protocol.ts";
import {
  applyEdits,
  nodesIn,
  qualifiedName,
  targetOf,
  targetsIn,
  unusedName,
} from "./syntax.ts";
import { changeTypes } from "./type-operations.ts";

const PREFERENCES: ts.UserPreferences = {
  providePrefixAndSuffixTextForRename: true,
  allowTextChangesInNewFiles: false,
};
const FORMAT: ts.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  convertTabsToSpaces: true,
  newLineCharacter: "\n",
};
const BINARY_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function primitive(type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every(primitive);
  }
  return [
    ts.TypeFlags.String,
    ts.TypeFlags.StringLiteral,
    ts.TypeFlags.Number,
    ts.TypeFlags.NumberLiteral,
    ts.TypeFlags.Boolean,
    ts.TypeFlags.BooleanLiteral,
    ts.TypeFlags.BigInt,
    ts.TypeFlags.BigIntLiteral,
    ts.TypeFlags.Null,
    ts.TypeFlags.Undefined,
  ].includes(type.flags);
}

function rejectDynamicScope(source: ts.SourceFile): void {
  if (
    nodesIn(source).some(
      (node: ts.Node): boolean =>
        ts.isWithStatement(node) ||
        (ts.isIdentifier(node) && node.text === "eval"),
    )
  ) {
    throw new Error("dynamic scope/eval is unsupported");
  }
}

function renameEdits(
  project: Project,
  file: string,
  position: number,
  name: string,
): ts.FileTextChanges[] {
  const info = project.service.getRenameInfo(file, position, PREFERENCES);
  if (!info.canRename) {
    throw new Error("language service refuses this rename");
  }
  const locations = project.service.findRenameLocations(
    file,
    position,
    false,
    false,
    PREFERENCES,
  );
  if (locations === undefined || locations.length === 0) {
    throw new Error("no rename locations");
  }
  const grouped = new Map<string, ts.TextChange[]>();
  for (const location of locations) {
    const changes = grouped.get(location.fileName) ?? [];
    changes.push({
      span: location.textSpan,
      newText: `${location.prefixText ?? ""}${name}${location.suffixText ?? ""}`,
    });
    grouped.set(location.fileName, changes);
  }
  return [...grouped].map(([fileName, textChanges]) => ({
    fileName,
    textChanges,
  }));
}

function rename(
  project: Project,
  operation: Extract<Operation, { operation: "rename-symbol" }>,
): void {
  const source = project.source(operation.target.file);
  const target = targetOf(source, operation.target.symbol);
  if (
    !(
      (ts.isVariableDeclaration(target) || ts.isParameter(target)) &&
      ts.isIdentifier(target.name)
    )
  ) {
    throw new Error("rename supports simple local primitive bindings only");
  }
  let parent: ts.Node = target.parent;
  while (!(ts.isSourceFile(parent) || ts.isFunctionLike(parent))) {
    ({ parent } = parent);
  }
  const checker = project.service.getProgram()?.getTypeChecker();
  if (
    ts.isSourceFile(parent) ||
    checker === undefined ||
    !primitive(checker.getTypeAtLocation(target.name))
  ) {
    throw new Error("only function-local primitive bindings may be renamed");
  }
  if (
    ts.isParameter(target) &&
    target.modifiers !== undefined &&
    target.modifiers.length > 0
  ) {
    throw new Error(
      "parameter properties/decorated parameters are public structure, not local bindings",
    );
  }
  if (target.name.text === "arguments") {
    throw new Error("implicit arguments bindings are unsupported");
  }
  // Expanding this shorthand into `__proto__: value` invokes a prototype setter.
  if (
    target.name.text === "__proto__" &&
    nodesIn(source).some(
      (node) =>
        ts.isShorthandPropertyAssignment(node) &&
        node.name.text === "__proto__",
    )
  ) {
    throw new Error("prototype-sensitive shorthand rename is unsupported");
  }
  rejectDynamicScope(source);
  unusedName(project, operation.name);
  applyEdits(
    project,
    renameEdits(
      project,
      source.fileName,
      target.name.getStart(source),
      operation.name,
    ),
  );
}

function pureExpression(node: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!primitive(checker.getTypeAtLocation(node))) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    return node.text !== "arguments";
  }
  if (
    ts.isLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isParenthesizedExpression(node)) {
    return pureExpression(node.expression, checker);
  }
  if (ts.isBinaryExpression(node)) {
    return (
      BINARY_OPERATORS.has(node.operatorToken.kind) &&
      pureExpression(node.left, checker) &&
      pureExpression(node.right, checker)
    );
  }
  if (ts.isConditionalExpression(node)) {
    return (
      pureExpression(node.condition, checker) &&
      pureExpression(node.whenTrue, checker) &&
      pureExpression(node.whenFalse, checker)
    );
  }
  if (ts.isPrefixUnaryExpression(node)) {
    return (
      (node.operator === ts.SyntaxKind.PlusToken ||
        node.operator === ts.SyntaxKind.MinusToken ||
        node.operator === ts.SyntaxKind.ExclamationToken ||
        node.operator === ts.SyntaxKind.TildeToken) &&
      pureExpression(node.operand, checker)
    );
  }
  return false;
}

function extract(
  project: Project,
  operation: Extract<Operation, { operation: "extract-function" }>,
): void {
  const source = project.source(operation.target.file);
  const target = targetOf(source, operation.target.symbol);
  if (
    !ts.isFunctionDeclaration(target) ||
    target.body === undefined ||
    target.asteriskToken !== undefined ||
    target.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    )
  ) {
    throw new Error(
      "extraction requires a synchronous named function declaration",
    );
  }
  if (target.body.statements.length < 2) {
    throw new Error(
      "whole-function forwarding extraction is unsupported; choose a cohesive part of substantial logic",
    );
  }
  const selected = nodesIn(target.body).find(
    (node: ts.Node): boolean =>
      ts.isReturnStatement(node) &&
      node.expression?.getStart(source) === operation.range.start &&
      node.expression.end === operation.range.end,
  );
  const checker = project.service.getProgram()?.getTypeChecker();
  if (
    selected === undefined ||
    !ts.isReturnStatement(selected) ||
    selected.expression === undefined ||
    selected.parent !== target.body ||
    checker === undefined ||
    !pureExpression(selected.expression, checker)
  ) {
    throw new Error(
      "select a direct function-body return expression using only primitive values and pure operators",
    );
  }
  rejectDynamicScope(source);
  unusedName(project, operation.name);
  const range = { pos: operation.range.start, end: operation.range.end };
  const available = project.service.getApplicableRefactors(
    source.fileName,
    range,
    PREFERENCES,
    "invoked",
    "refactor.extract.function",
  );
  const refactor = available.find((entry) =>
    entry.actions.some(
      (action) =>
        action.name === "function_scope_0" &&
        action.notApplicableReason === undefined,
    ),
  );
  if (refactor === undefined) {
    throw new Error("language service offers no inner-function extraction");
  }
  const result = project.service.getEditsForRefactor(
    source.fileName,
    FORMAT,
    range,
    refactor.name,
    "function_scope_0",
    PREFERENCES,
  );
  if (
    result === undefined ||
    result.renameLocation === undefined ||
    result.renameFilename !== source.fileName
  ) {
    throw new Error("language service returned an unsupported extraction");
  }
  applyEdits(project, result.edits);
  applyEdits(
    project,
    renameEdits(
      project,
      source.fileName,
      result.renameLocation,
      operation.name,
    ),
  );
  const updated = targetOf(
    project.source(operation.target.file),
    operation.target.symbol,
  );
  if (!ts.isFunctionDeclaration(updated)) {
    throw new Error("extraction changed the target declaration kind");
  }
  const helper = nodesIn(updated).find(
    (node: ts.Node): boolean =>
      ts.isFunctionDeclaration(node) && node.name?.text === operation.name,
  );
  if (
    helper === undefined ||
    !ts.isFunctionDeclaration(helper) ||
    helper.parameters.length > 0 ||
    helper.parent !== updated.body
  ) {
    throw new Error(
      "only a non-escaping inner helper with closed-over inputs is supported",
    );
  }
}

interface Inspection {
  file: string;
  text: string;
  offset: number;
  totalCharacters: number;
  targets: { symbol: string; start: number; end: number }[];
  returnExpressions: { start: number; end: number }[];
  operations: string[];
  backend: string;
  limitations: string;
}

function inspect(
  project: Project,
  relative: string,
  offset: number,
  limit: number,
): Inspection {
  const source = project.source(relative);
  return {
    file: relative,
    text: project.read(relative).slice(offset, offset + limit),
    offset,
    totalCharacters: project.read(relative).length,
    targets: targetsIn(source)
      .filter(
        (node) =>
          node.getStart(source) >= offset &&
          node.getStart(source) < offset + limit,
      )
      .map((node) => ({
        symbol: qualifiedName(node),
        start: node.getStart(source),
        end: node.end,
      })),
    returnExpressions: nodesIn(source)
      .filter(ts.isReturnStatement)
      .flatMap((node) => {
        if (
          node.expression === undefined ||
          node.expression.getStart(source) < offset ||
          node.expression.getStart(source) >= offset + limit
        ) {
          return [];
        }
        return [
          { start: node.expression.getStart(source), end: node.expression.end },
        ];
      }),
    operations: [
      "rename-symbol",
      "extract-function",
      "introduce-type",
      "modify-type",
      "remove-type",
      "set-type-annotation",
      "remove-type-annotation",
    ],
    backend: `typescript@${ts.version}`,
    limitations:
      "Conservative local primitive rename, pure return-expression extraction and checked type-only edits. Type operations require unchanged whole-project JavaScript emission and passing projected checks. Introduction creates a top-level alias/interface; named-type operations can update selected annotations atomically in that file. Unsupported or ambiguous syntax refuses. External TypeScript API compatibility is not proven.",
  };
}

function transform(
  project: Project,
  operation: Exclude<Operation, { operation: "inspect" | "check" | "read" }>,
): void {
  if (operation.operation === "rename-symbol") {
    rename(project, operation);
  } else if (operation.operation === "extract-function") {
    extract(project, operation);
  } else {
    changeTypes(project, operation);
  }
}

export { inspect, transform };
