/**
 * Credential redaction — the single authority.
 * ==================================================================
 * Everything AURA sends to a model provider passes through one of two
 * composers, and both call the function in this file. Nothing else in the
 * codebase may define a secret pattern or a redaction routine.
 *
 *   context/promptContract.ts   → agent prompt   → redact() in block()
 *   intelligence/contextAssembler.ts → chat prompt → redact() at assembly
 *
 * This module exists because those two paths used to disagree. The agent
 * path redacted at its render boundary; the chat path did not redact at
 * all, so a credential sitting in a source file was retrieved as an
 * excerpt and travelled verbatim to a third-party provider. Copying the
 * patterns into the second path would have produced two authorities that
 * drift; extracting them produces one that cannot.
 *
 * ── What this is, and what it is not ─────────────────────────────────
 * It is defence in depth behind "AURA does not put secrets in context in
 * the first place". It is NOT a secret scanner, and it must never be
 * described as one. It matches SHAPES — the fixed prefixes and encodings
 * that real credentials carry — because a shape is checkable and a name
 * is a guess.
 *
 * ── Why the name=value rule is value-aware ───────────────────────────
 * One pattern here does match on a name, because `password: <literal>` is
 * the one construction common enough to be worth catching by name. The
 * original form of that rule redacted everything after the separator:
 *
 *     /\b(?:...|password|token|...)\s*[:=]\s*\S+/gi
 *
 * On free text (a commit subject, a module description) that is harmless.
 * On the chat path the retrieved material IS source code, and there the
 * same rule destroys meaning: a TypeScript field `password: string` and
 * an assignment `apiKey = process.env.OPENAI_KEY` both become `[redacted]`,
 * so the model is asked to explain code it can no longer see. Answers get
 * worse and nothing is protected — neither of those is a credential.
 *
 * So both halves have to earn the redaction. The NAME is tokenised into
 * words across `_`, `-` and camelCase, so `DATABASE_PASSWORD` matches and
 * `tokenizer` does not — a substring search cannot tell those apart. The
 * VALUE must then look like a constant: a quoted literal already is one,
 * while an unquoted value has to be long and opaque and must not be the
 * thing code actually writes there — a dotted path (`process.env.KEY`,
 * `this.token`, `config.secret`), a function call, or a keyword. Type
 * names like `string` fall out for free on length.
 *
 * The key is preserved and only the value replaced, so a code excerpt
 * keeps its structure: the model can still see THAT a token is assigned
 * without seeing which one.
 */

/** What replaces a redacted value. Stable — tests and journals match it. */
export const REDACTION_MARKER = '[redacted]';

/**
 * Credential shapes. Each entry matches a format that is a credential and
 * essentially nothing else, so these fire regardless of surrounding text.
 */
export const SECRET_SHAPE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,                                 // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,                                              // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                    // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                                  // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,                                // PEM private keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g,                           // Authorization header
];

/**
 * `name = value`, for every name — the decision is made in code below.
 *
 * Group 1 is the name, group 2 the separator (which may carry the closing
 * quote of a JSON key), group 3 the opening quote of the value, group 4
 * the value itself. The pattern only finds candidates; whether a candidate
 * is a credential is decided by {@link isSecretName} and
 * {@link isSecretValue}, because both questions need more than a regex.
 */
const ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_-]{0,63})(["']?\s*[:=]\s*)(["'`]?)([A-Za-z0-9_\-+/=.~]{4,})\3/g;

/**
 * Split an identifier into lowercase words across `_`, `-` and camelCase.
 *
 * Matching whole words rather than substrings is what keeps `tokenizer`
 * and `tokens` out: both contain "token", neither names a credential.
 */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Words that name a credential on their own. */
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passphrase',
  'secret', 'secrets', 'token', 'bearer',
  'credential', 'credentials', 'apikey', 'apisecret',
]);

/** Adjacent word pairs that name a credential together. */
const SECRET_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'], ['access', 'key'], ['secret', 'key'], ['private', 'key'],
  ['client', 'secret'], ['api', 'secret'],
  ['auth', 'token'], ['access', 'token'], ['refresh', 'token'], ['id', 'token'],
];

/**
 * Does this identifier name a credential?
 *
 * `DATABASE_PASSWORD`, `myApiKey` and `GITHUB_TOKEN` do. `tokenizer`,
 * `tokens` and `timeout` do not, and the difference is word boundaries —
 * which is why the name is tokenised rather than searched.
 */
function isSecretName(name: string): boolean {
  const w = words(name);
  if (w.some((x) => SECRET_WORDS.has(x))) return true;
  for (let i = 0; i + 1 < w.length; i += 1) {
    for (const [a, b] of SECRET_WORD_PAIRS) {
      if (w[i] === a && w[i + 1] === b) return true;
    }
  }
  return false;
}

/** Values that are code, not credentials, however long they are. */
const NOT_A_SECRET = new Set([
  'null', 'undefined', 'true', 'false', 'none', 'nil', 'nan',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never',
  'str', 'int', 'bool', 'text', 'varchar', 'required', 'optional',
]);

/** An identifier, or a dotted path of identifiers — i.e. a reference. */
const DOTTED_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

/**
 * Decide whether a `name = value` candidate is carrying a real credential.
 *
 * `quoted` matters because quoting is itself evidence: a quoted value is a
 * literal the author typed, so a shorter one is still worth hiding. An
 * unquoted value is usually an expression, so it has to be long AND opaque
 * before we are willing to destroy it.
 *
 * `nextChar` catches the call case — `token = readToken()` reaches here as
 * the value `readToken`, and only the following `(` distinguishes it from
 * a literal.
 */
function isSecretValue(value: string, quoted: boolean, nextChar: string): boolean {
  if (NOT_A_SECRET.has(value.toLowerCase())) return false;
  // A quoted value is a literal the author typed. It does not need to clear
  // the tests below, because none of them can be true of a string constant:
  // "process.env.KEY" inside quotes is text, not a lookup.
  if (quoted) return value.length >= 6;
  if (nextChar === '(') return false;          // a call, not a constant
  if (DOTTED_PATH.test(value)) return false;   // process.env.X, this.token, config.secret
  return value.length >= 12;
}

/**
 * Replace anything credential-shaped with a marker that says what happened.
 *
 * Returns the text unchanged when nothing matched, so callers can apply it
 * unconditionally at a choke point without paying for a rebuild.
 */
export function redact(text: string): string {
  return redactWithCount(text).text;
}

export interface RedactionResult {
  /** The redacted text. */
  text: string;
  /** How many substitutions were made. Recorded, never guessed. */
  count: number;
}

/**
 * As {@link redact}, but reports how much it removed.
 *
 * The count is what makes redaction auditable: a journal entry can record
 * that a prompt was filtered without recording what was filtered out of it.
 */
export function redactWithCount(text: string): RedactionResult {
  let count = 0;
  let out = text;

  for (const pattern of SECRET_SHAPE_PATTERNS) {
    out = out.replace(pattern, () => {
      count += 1;
      return REDACTION_MARKER;
    });
  }

  out = out.replace(
    ASSIGNMENT_PATTERN,
    (match, name: string, sep: string, quote: string, value: string, offset: number, whole: string) => {
      if (!isSecretName(name)) return match;
      const nextChar = whole.charAt(offset + match.length);
      if (!isSecretValue(value, quote.length > 0, nextChar)) return match;
      count += 1;
      return `${name}${sep}${quote}${REDACTION_MARKER}${quote}`;
    },
  );

  return { text: out, count };
}
