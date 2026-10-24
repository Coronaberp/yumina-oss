import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

test("editor route preference reads do not import an editor component eagerly", () => {
  for (const path of ["../routes/app/worlds.create.tsx", "../routes/app/worlds.$worldId.edit.tsx", "../features/editor/editor-shell.tsx"]) {
    const imports = source(path).statements.filter(ts.isImportDeclaration)
      .filter(node => !node.importClause?.isTypeOnly)
      .map(node => ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "");
    assert.ok(!imports.some(specifier => specifier.endsWith("/quick-create-editor")), `${path} pulls the lazy editor into its eager graph`);
  }
});

test("application startup leaves ChatView loading to the persistent chat boundary", () => {
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source("../main.tsx"));
  assert.ok(!imports.includes("@/features/chat/chat-view"), "startup must not download/evaluate ChatView before a chat is opened");
});
