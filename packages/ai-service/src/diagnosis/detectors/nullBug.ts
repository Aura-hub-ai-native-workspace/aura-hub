/**
 * Null/undefined-access detector — pure syntax parse, no type checker.
 * ==================================================================
 * Finds real nullable sources (a parameter typed `T | null`/`T | undefined`
 * or optional `?:`, or a local bound to a known nullable-returning call
 * like `.find(`/`Map.get(`/`.exec(`/`.match(`/`document.getElementById(`)
 * and walks the enclosing function in source order for a property/element
 * access on that name that is neither optional-chained (`?.`) nor preceded
 * by a real narrowing guard (`if(x)`, `if(!x) return/throw`, `x==null`,
 * `x&&x.y`, `x??`) as an earlier statement. A coarse, honestly-labeled
 * heuristic — not full control-flow analysis — documented as a scope cut.
 */
import ts from 'typescript';
import { isFunctionLike, parseSource } from '../tsHelpers';
import type { DetectorContext, DetectorResult } from '../types';

const NULLABLE_CALL_NAMES = new Set(['find', 'get', 'exec', 'match', 'getElementById']);

function findEnclosingFunction(sf: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (node.getStart(sf) <= pos && pos <= node.getEnd()) {
      if (isFunctionLike(node)) found = node;
      ts.forEachChild(node, visit);
    }
  };
  visit(sf);
  return found;
}

function offsetForLine(text: string, line1: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(line1 - 1, lines.length); i++) offset += lines[i].length + 1;
  return offset;
}

function isNullableTypeText(text: string): boolean {
  return /\bnull\b/.test(text) || /\bundefined\b/.test(text);
}

function nullableCallSourceName(init: ts.Expression): string | null {
  if (!ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return null;
  return NULLABLE_CALL_NAMES.has(init.expression.name.text) ? init.expression.name.text : null;
}

export function detectNullBug(ctx: DetectorContext): DetectorResult {
  const sf = parseSource(ctx.absFilePath, ctx.fileText, ctx.language);

  const anchorPos = ctx.selectionRange ? offsetForLine(ctx.fileText, ctx.selectionRange.startLine) : 0;
  const scope: ts.Node = findEnclosingFunction(sf, anchorPos) ?? sf;

  const nullableNames = new Map<string, string>(); // name -> why it's nullable
  if (isFunctionLike(scope)) {
    for (const param of scope.parameters) {
      if (!ts.isIdentifier(param.name)) continue;
      const optional = Boolean(param.questionToken);
      const typeText = param.type ? param.type.getText(sf) : '';
      if (optional || isNullableTypeText(typeText)) {
        nullableNames.set(param.name.text, `parameter \`${param.name.text}\`${optional ? ' is optional' : ` is typed \`${typeText}\``}`);
      }
    }
  }
  const collectDecls = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const via = nullableCallSourceName(node.initializer);
      if (via) nullableNames.set(node.name.text, `\`${node.name.text}\` is assigned from a nullable-returning \`.${via}(...)\` call`);
    }
    ts.forEachChild(node, collectDecls);
  };
  collectDecls(scope);

  const evidence: string[] = [...nullableNames.values()];
  const hits: string[] = [];
  const guarded = new Set<string>();

  const guardsName = (exprText: string, name: string): boolean => {
    const re = (p: string) => new RegExp(p).test(exprText);
    return (
      re(`^!?\\s*${name}\\b\\s*$`) ||
      re(`^!?\\s*${name}\\b\\s*&&`) ||
      re(`${name}\\s*(==|===|!=|!==)\\s*(null|undefined)`) ||
      re(`${name}\\s*\\?\\?`)
    );
  };

  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const condText = node.expression.getText(sf);
      for (const name of nullableNames.keys()) if (guardsName(condText, name)) guarded.add(name);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const leftText = node.left.getText(sf);
        for (const name of nullableNames.keys()) if (guardsName(leftText, name) || leftText.trim() === name) guarded.add(name);
      }
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !node.questionDotToken) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && nullableNames.has(expr.text) && !guarded.has(expr.text)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push(`\`${node.getText(sf)}\` at line ${line} accesses \`${expr.text}\` without a preceding null/undefined guard`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);

  const checksRun = [
    { name: 'nullable source identified (optional param or nullable-returning call)', fired: nullableNames.size > 0 },
    { name: 'unguarded property/element access on a nullable source', fired: hits.length > 0 },
  ];

  return { fires: checksRun.every((c) => c.fired), evidence: [...evidence, ...hits], checksRun };
}
