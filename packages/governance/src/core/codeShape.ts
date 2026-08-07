/**
 * Code shape — real structural measurements of functions/classes.
 * ==================================================================
 * Brace-matched span estimation for functions and classes in TS/JS
 * source. The estimator is conservative (declaration/arrow-function
 * forms only, never regex-on-strings alone) and every measurement is
 * labelled with its basis so it can be audited.
 */

export interface FunctionShape {
  name: string;
  kind: 'function' | 'method' | 'arrow';
  startLine: number; // 1-based
  endLine: number;
  span: number;
  complexity: number; // decision points: if/for/while/case/&&/||/?
}

export interface ClassShape {
  name: string;
  startLine: number;
  endLine: number;
  span: number;
  methods: number;
}

const FUNC_DECL_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/;
const ARROW_RE = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/;
const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const METHOD_RE = /^\s{0,8}(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;

const COMPLEXITY_TOKENS = /\b(if|for|while|catch|case)\b|[?&|]/g;

function lineDepthDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

export interface CodeShape {
  functions: FunctionShape[];
  classes: ClassShape[];
  maxFunctionSpan: number;
  maxClassSpan: number;
  totalFunctions: number;
  functionsOverLines: number;
  classesOverLines: number;
}

export function analyzeCodeShape(text: string, opts: { functionLineLimit?: number; classLineLimit?: number } = {}): CodeShape {
  const functionLineLimit = opts.functionLineLimit ?? 80;
  const classLineLimit = opts.classLineLimit ?? 300;
  const lines = text.split('\n');
  const functions: FunctionShape[] = [];
  const classes: ClassShape[] = [];

  let depth = 0;
  let classDepth = -1; // depth at which the current class body started
  let currentClass: ClassShape | null = null;
  let classStart = 0;
  let currentClassMethods = 0;

  const trackClassEnd = (): void => {
    if (currentClass) {
      currentClass.endLine = classStart;
      classes.push(currentClass);
      currentClass = null;
      classDepth = -1;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const before = depth;
    depth += lineDepthDelta(line);
    const after = depth;

    // Class tracking (only at depth 0 to avoid nested functions).
    const classMatch = CLASS_RE.exec(trimmed);
    if (classMatch && before === 0 && !currentClass) {
      classDepth = after;
      classStart = i + 1;
      currentClass = { name: classMatch[1], startLine: i + 1, endLine: i + 1, span: 0, methods: 0 };
      currentClassMethods = 0;
      if (after <= before && after <= 0) trackClassEnd();
      continue;
    }
    if (currentClass) {
      if (after < classDepth) {
        trackClassEnd();
      } else {
        if (METHOD_RE.test(trimmed)) currentClassMethods++;
        currentClass.endLine = i + 1;
      }
      // fall through — a function could start inside a class? no: keep class rule.
    }

    const fn = matchFunctionStart(trimmed);
    if (fn) {
      const startDepth = before;
      let fnDepth = after;
      let endLine = i + 1;
      if (after <= startDepth) {
        // single-line body — span 1
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          fnDepth += lineDepthDelta(lines[j]);
          endLine = j + 1;
          if (fnDepth <= startDepth) break;
        }
      }
      const span = endLine - (i + 1) + 1;
      if (span >= 2) {
        const body = lines.slice(i + 1, endLine).join('\n');
        const complexity = (body.match(COMPLEXITY_TOKENS) ?? []).length;
        functions.push({ name: fn.name, kind: fn.kind, startLine: i + 1, endLine, span, complexity });
      }
    }
  }

  const sorted = [...functions].sort((a, b) => b.span - a.span);
  return {
    functions,
    classes,
    maxFunctionSpan: sorted[0]?.span ?? 0,
    maxClassSpan: classes.reduce((m, c) => Math.max(m, c.span), 0),
    totalFunctions: functions.length,
    functionsOverLines: functions.filter((f) => f.span > functionLineLimit).length,
    classesOverLines: classes.filter((c) => c.span > classLineLimit).length,
  };
}

function matchFunctionStart(trimmed: string): { name: string; kind: FunctionShape['kind'] } | null {
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return null;
  const decl = FUNC_DECL_RE.exec(trimmed);
  if (decl) return { name: decl[1], kind: 'function' };
  const arrow = ARROW_RE.exec(trimmed);
  if (arrow) return { name: arrow[1], kind: 'arrow' };
  return null;
}

export interface ComplexityStats {
  averageComplexity: number;
  maxComplexity: number;
  complexFunctions: number; // complexity > 10
}

export function complexityStats(shape: CodeShape): ComplexityStats {
  const total = shape.functions.reduce((s, f) => s + f.complexity, 0);
  return {
    averageComplexity: shape.totalFunctions ? total / shape.totalFunctions : 0,
    maxComplexity: shape.functions.reduce((m, f) => Math.max(m, f.complexity), 0),
    complexFunctions: shape.functions.filter((f) => f.complexity > 10).length,
  };
}
