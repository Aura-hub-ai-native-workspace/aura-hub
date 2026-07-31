/**
 * tsHelpers — shared TypeScript-compiler-API bits used by the null-bug
 * and broken-API detectors and by Patch Simulation's compile check.
 * Parser-only (`ts.createSourceFile`) or `ts.transpileModule` — never
 * `ts.createProgram` (would need cross-package project-reference
 * resolution across this monorepo; explicit scope cut).
 */
import ts from 'typescript';

export function scriptKindFor(language: string): ts.ScriptKind {
  if (/tsx/i.test(language)) return ts.ScriptKind.TSX;
  if (/jsx/i.test(language)) return ts.ScriptKind.JSX;
  if (/javascript/i.test(language)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseSource(fileName: string, text: string, language: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(language));
}

/** Best-effort language label from a file extension — for parsing files other than the one the request named. */
export function languageForPath(absPath: string): string {
  if (/\.tsx$/.test(absPath)) return 'typescript-tsx';
  if (/\.jsx$/.test(absPath)) return 'javascript-jsx';
  if (/\.[cm]?js$/.test(absPath)) return 'javascript';
  return 'typescript';
}

export function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

export interface DeclaredName { name: string; line: number }

/** Every named function/class/interface/type/enum/variable declaration in the file, with its start line. */
export function collectDeclaredNames(sf: ts.SourceFile): DeclaredName[] {
  const out: DeclaredName[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) out.push({ name: node.name.text, line: lineOf(node) });
    else if (ts.isClassDeclaration(node) && node.name) out.push({ name: node.name.text, line: lineOf(node) });
    else if (ts.isInterfaceDeclaration(node)) out.push({ name: node.name.text, line: lineOf(node) });
    else if (ts.isTypeAliasDeclaration(node)) out.push({ name: node.name.text, line: lineOf(node) });
    else if (ts.isEnumDeclaration(node)) out.push({ name: node.name.text, line: lineOf(node) });
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) out.push({ name: node.name.text, line: lineOf(node) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Textual, entity-free fallback for "what symbol is at/near this line" —
 * used when the knowledge graph has no Entity here at all (Gap 2: plain,
 * non-framework-shaped files never become graph entities, so the
 * graph-based `nearestSymbol` heuristic returns null for most ordinary
 * utility code). Same line-proximity heuristic, applied to real
 * declarations found by parsing the file directly.
 */
export function nearestDeclaredName(sf: ts.SourceFile, line: number): DeclaredName | null {
  const names = collectDeclaredNames(sf).sort((a, b) => a.line - b.line);
  let best: DeclaredName | null = null;
  for (const d of names) {
    if (d.line <= line) best = d;
    else break;
  }
  return best;
}

export interface ParsedSignature {
  name: string;
  requiredParamCount: number;
  totalParamCount: number;
  returnTypeText: string | null;
}

/** Parse a named function/arrow/method's signature — required vs. total param count, textual return type. */
export function parseSignature(sf: ts.SourceFile, name: string): ParsedSignature | null {
  let params: ts.NodeArray<ts.ParameterDeclaration> | null = null;
  let returnType: ts.TypeNode | undefined;
  const visit = (node: ts.Node) => {
    if (params) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) { params = node.parameters; returnType = node.type; return; }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) { params = node.parameters; returnType = node.type; return; }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      params = node.initializer.parameters;
      returnType = node.initializer.type;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!params) return null;
  const list = params as ts.NodeArray<ts.ParameterDeclaration>;
  const required = list.filter((p) => !p.questionToken && !p.initializer && !p.dotDotDotToken).length;
  return {
    name,
    requiredParamCount: required,
    totalParamCount: list.length,
    returnTypeText: returnType ? returnType.getText(sf) : null,
  };
}

