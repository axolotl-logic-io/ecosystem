// A TypeScript file's zod schemas, as the spec writer's scope rule reads them
// (type-only-additions.ts): a schema is an expression of calls and property
// reads rooted at `z`, or at one of the file's schema constants, that calls
// no parse method; a schema constant is a `const` statement whose every
// value is a schema. Reducing a file's schemas turns each schema into `z`,
// leaves each schema constant out, and drops them from its value export
// lists, so two versions of a file that differ only in their schemas reduce
// to the same text. Pure: it reads only its arguments.

import type { Node, SourceFile } from "typescript";

type TypeScript = typeof import("typescript");

// The identifier a zod schema expression is rooted at.
const ZOD = "z";
// The methods that run a schema rather than build one.
const PARSE_METHODS: ReadonlySet<string> = new Set([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "spa",
  "encode",
  "decode",
  "safeEncode",
  "safeDecode",
]);

// A text edit: the span from `start` to `end` becomes `text`.
interface Edit {
  start: number;
  end: number;
  text: string;
}

// A file's schemas read: its text with them reduced (`reduced`), and the
// 1-based lines its schemas, schema constants and export lists fill, where
// a line may change.
interface Schemas {
  reduced: string;
  lines: ReadonlySet<number>;
}

// The identifier at the root of `node`'s chain of calls and property reads,
// or undefined when it has none or the chain calls a parse method.
function chainRoot(ts: TypeScript, node: Node): string | undefined {
  let link = node;
  while (ts.isCallExpression(link) || ts.isPropertyAccessExpression(link)) {
    if (
      ts.isPropertyAccessExpression(link) &&
      PARSE_METHODS.has(link.name.text)
    ) {
      return undefined;
    }
    link = link.expression;
  }
  if (ts.isIdentifier(link)) {
    return link.text;
  }
  return undefined;
}

// Whether `node` is a zod schema expression: a call or property read whose
// chain is rooted at `z` or at one of the file's schema constants `names`.
function isSchema(ts: TypeScript, node: Node, names: Set<string>): boolean {
  if (!(ts.isCallExpression(node) || ts.isPropertyAccessExpression(node))) {
    return false;
  }
  const root = chainRoot(ts, node);
  return root === ZOD || (root !== undefined && names.has(root));
}

// The names a `const` statement declares when every value is a schema, or
// undefined when it is not one.
function schemaConstants(
  ts: TypeScript,
  node: Node,
  names: Set<string>,
): string[] | undefined {
  if (!ts.isVariableStatement(node)) {
    return undefined;
  }
  const { declarations } = node.declarationList;
  const named = declarations.flatMap((declaration) => {
    const { name, initializer } = declaration;
    if (
      ts.isIdentifier(name) &&
      initializer !== undefined &&
      isSchema(ts, initializer, names)
    ) {
      return [name.text];
    }
    return [];
  });
  if (named.length === 0 || named.length !== declarations.length) {
    return undefined;
  }
  return named;
}

// The export list `node` without the schema constants `names`, or undefined
// when `node` is not a value export list.
function exportWithout(
  ts: TypeScript,
  node: Node,
  names: Set<string>,
): string | undefined {
  if (
    !ts.isExportDeclaration(node) ||
    node.isTypeOnly ||
    node.moduleSpecifier !== undefined ||
    node.exportClause === undefined ||
    !ts.isNamedExports(node.exportClause)
  ) {
    return undefined;
  }
  const kept = node.exportClause.elements
    .filter(
      (element) => !names.has((element.propertyName ?? element.name).getText()),
    )
    .map((element) => element.getText());
  if (kept.length === 0) {
    return "";
  }
  return `export { ${kept.join(", ")} };`;
}

// `text`'s schemas reduced: each schema expression becomes `z`, each schema
// constant is left out and each value export list loses them.
function schemasOf(ts: TypeScript, fileName: string, text: string): Schemas {
  const source: SourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ESNext,
    true,
  );
  const names = new Set<string>();
  const edits: Edit[] = [];
  const exports: Node[] = [];
  function visit(node: Node): void {
    const constants = schemaConstants(ts, node, names);
    if (constants !== undefined) {
      for (const name of constants) {
        names.add(name);
      }
      edits.push({ start: node.getStart(), end: node.end, text: "" });
    } else if (isSchema(ts, node, names)) {
      edits.push({ start: node.getStart(), end: node.end, text: ZOD });
    } else if (ts.isExportDeclaration(node)) {
      exports.push(node);
    } else {
      ts.forEachChild(node, visit);
    }
  }
  visit(source);
  for (const node of exports) {
    const kept = exportWithout(ts, node, names);
    if (kept !== undefined) {
      edits.push({ start: node.getStart(), end: node.end, text: kept });
    }
  }
  const lines = new Set<number>();
  for (const { start, end } of [...edits, ...exports.map(spanOf)]) {
    const first = source.getLineAndCharacterOfPosition(start).line;
    const last = source.getLineAndCharacterOfPosition(end).line;
    for (let line = first; line <= last; line += 1) {
      lines.add(line + 1);
    }
  }
  let reduced = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    reduced =
      reduced.slice(0, edit.start) + edit.text + reduced.slice(edit.end);
  }
  return { reduced, lines };
}

function spanOf(node: Node): Edit {
  return { start: node.getStart(), end: node.end, text: "" };
}

export type { Schemas };
export { schemasOf };
