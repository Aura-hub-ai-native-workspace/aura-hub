/**
 * intentClassifier — Stage 1, deterministic. Runs BEFORE any model call.
 * ==================================================================
 * Different mission text must be able to route to structurally
 * different plans, and that routing decision must not itself be a
 * model's opinion — it's the one thing this pipeline can get
 * completely right, every time, for free. Each category owns its own
 * fixed set of real keyword/phrase patterns; the category with the
 * most DISTINCT patterns matched (not most occurrences — repeating a
 * word does not strengthen a match) wins. `'unknown'` is a real,
 * honest outcome when nothing matches — the pipeline does not force a
 * guess.
 *
 * The LLM (see `intentExtraction.ts`) is only ever allowed to choose
 * among the candidates this function actually surfaces — it can
 * re-rank, it cannot invent.
 */
import type { CategoryCandidate, IntentClassification, MissionCategory } from './types';

interface Pattern {
  label: string;
  re: RegExp;
}

const PATTERNS: Record<Exclude<MissionCategory, 'unknown'>, Pattern[]> = {
  presentation: [
    { label: 'presentation', re: /\bpresentation\b/i },
    { label: 'demo', re: /\bdemo(s|ing)?\b/i },
    { label: 'showcase', re: /\bshowcase\b/i },
    { label: 'pitch', re: /\bpitch(ing)?\b/i },
    { label: 'present to', re: /\bpresent(ing)?\s+(to|for|at)\b/i },
    { label: 'stakeholders/audience', re: /\b(stakeholders?|audience|investors?|client meeting)\b/i },
  ],
  deployment: [
    { label: 'deploy', re: /\bdeploy(ed|ing|ment)?\b/i },
    { label: 'production', re: /\bprod(uction)?\b/i },
    { label: 'ship it', re: /\bship(ping)?\s+(it|to)\b/i },
    { label: 'go live / launch', re: /\b(go[\s-]?live|launch(ing)?)\b/i },
    { label: 'hosting/infra', re: /\b(hosting|infrastructure|server setup)\b/i },
  ],
  release: [
    { label: 'release', re: /\breleas(e|ing|ed)\b/i },
    { label: 'version/changelog', re: /\b(version(ing)?|changelog|release notes)\b/i },
    { label: 'cut a release', re: /\bcut\s+(a\s+)?release\b/i },
    { label: 'tag', re: /\btag(ging)?\s+(a\s+)?(release|version)\b/i },
  ],
  security: [
    { label: 'security', re: /\bsecur(e|ity|ing)\b/i },
    { label: 'vulnerability', re: /\bvulnerab(le|ility|ilities)\b/i },
    { label: 'secrets', re: /\bsecrets?\b/i },
    { label: 'permissions/access', re: /\b(permissions?|access control|authoriz)/i },
    { label: 'owasp/audit', re: /\b(owasp|security audit|pen[\s-]?test)/i },
    { label: 'exploit', re: /\bexploit(s|ed|able)?\b/i },
  ],
  performance: [
    { label: 'performance', re: /\bperformance\b/i },
    { label: 'slow/speed', re: /\b(slow|speed\s?up|faster)\b/i },
    { label: 'optimi[sz]e', re: /\boptimi[sz](e|ation|ing)\b/i },
    { label: 'latency', re: /\blatency\b/i },
    { label: 'benchmark/profile', re: /\b(benchmark(ing)?|profil(e|ing))\b/i },
    { label: 'memory/cpu', re: /\b(memory leak|cpu usage|bottleneck)\b/i },
  ],
  'bug-resolution': [
    { label: 'fix', re: /\bfix(ing|ed)?\b/i },
    { label: 'bug', re: /\bbugs?\b/i },
    { label: 'broken/crash', re: /\b(broken|crash(es|ing|ed)?)\b/i },
    { label: 'error/issue', re: /\b(error|issue)s?\b/i },
    { label: 'debug', re: /\bdebug(ging)?\b/i },
    { label: 'not working', re: /\bnot\s+working\b/i },
  ],
  testing: [
    { label: 'test', re: /\btest(s|ing)?\b/i },
    { label: 'coverage', re: /\b(test\s+)?coverage\b/i },
    { label: 'unit/integration test', re: /\b(unit|integration|e2e)\s+tests?\b/i },
    { label: 'qa', re: /\bqa\b/i },
  ],
  documentation: [
    { label: 'documentation', re: /\bdocumentation\b/i },
    { label: 'docs', re: /\bdocs?\b/i },
    { label: 'readme', re: /\breadme\b/i },
    { label: 'guide/explain', re: /\b(guide|explain(er)?|write[\s-]?up)\b/i },
  ],
  'feature-development': [
    { label: 'build/implement', re: /\b(build|implement(ing)?)\b/i },
    { label: 'add feature', re: /\badd(ing)?\s+(a\s+)?(feature|functionality)?/i },
    { label: 'new feature', re: /\bnew\s+feature\b/i },
    { label: 'develop', re: /\bdevelop(ing|ment)?\b/i },
    { label: 'integrate', re: /\bintegrat(e|ion|ing)\b/i },
    { label: 'create', re: /\bcreate\b/i },
  ],
  architecture: [
    { label: 'architecture', re: /\barchitectur(e|al)\b/i },
    { label: 'redesign', re: /\bredesign(ing)?\b/i },
    { label: 'modularize', re: /\bmodulariz(e|ation)\b/i },
    { label: 'decouple', re: /\bdecoupl(e|ing)\b/i },
    { label: 'layering/boundaries', re: /\b(layering|module boundaries|separation of concerns)\b/i },
  ],
  refactoring: [
    { label: 'refactor', re: /\brefactor(ing|ed)?\b/i },
    { label: 'clean(er) code', re: /\bclean(er|up)?\s+code\b/i },
    { label: 'simplify', re: /\bsimplify(ing)?\b/i },
    { label: 'restructure', re: /\brestructur(e|ing)\b/i },
    { label: 'rewrite', re: /\brewrit(e|ing)\b/i },
  ],
  migration: [
    { label: 'migrate', re: /\bmigrat(e|ion|ing)\b/i },
    { label: 'upgrade version', re: /\bupgrad(e|ing)\b/i },
    { label: 'port to', re: /\bport(ing)?\s+to\b/i },
    { label: 'move to', re: /\bmov(e|ing)\s+to\b/i },
    { label: 'transition', re: /\btransition(ing)?\b/i },
  ],
  maintenance: [
    { label: 'maintain', re: /\bmaintain(ing|ance|enance)?\b/i },
    { label: 'clean up / housekeeping', re: /\b(clean[\s-]?up|housekeeping|tidy(ing)?)\b/i },
    { label: 'update dependencies', re: /\bupdate\s+dependenc(y|ies)\b/i },
    { label: 'dead code', re: /\bdead\s+code\b/i },
    { label: 'technical debt', re: /\btechnical\s+debt\b/i },
  ],
  research: [
    { label: 'research', re: /\bresearch(ing)?\b/i },
    { label: 'explore/investigate', re: /\b(explor(e|ing)|investigat(e|ing|ion))\b/i },
    { label: 'evaluate', re: /\bevaluat(e|ing|ion)\b/i },
    { label: 'spike', re: /\bspike\b/i },
    { label: 'feasibility', re: /\bfeasibility\b/i },
  ],
};

const CATEGORIES = Object.keys(PATTERNS) as Exclude<MissionCategory, 'unknown'>[];

export function classifyMissionIntent(text: string): IntentClassification {
  const candidates: CategoryCandidate[] = CATEGORIES.map((category) => {
    const matchedSignals = PATTERNS[category].filter((p) => p.re.test(text)).map((p) => p.label);
    return { category, score: matchedSignals.length, matchedSignals };
  })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return { category: 'unknown', confidence: 0, candidates: [], source: 'deterministic' };
  }

  const top = candidates[0];
  const totalMatches = candidates.reduce((s, c) => s + c.score, 0);
  const confidence = Math.min(0.99, top.score / Math.max(totalMatches, 1));

  return {
    category: top.category,
    confidence,
    candidates: candidates.slice(0, 4),
    source: 'deterministic',
  };
}
