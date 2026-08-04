/**
 * errorTranslator — turns a provider's raw HTTP failure (status code +
 * response body) into one of a fixed set of user-facing categories. This is
 * the one place that decides what an AI error *means*, so nobody sees a raw
 * provider payload like `API error 403: NOT_ENOUGH_BALANCE` — they see
 * "Novita account has no remaining credits." instead.
 *
 * Provider adapters throw `ProviderHttpError` (below) instead of a plain
 * `Error` so this translator gets real structure — status + body — rather
 * than having to regex a formatted message string. Wired into pipeline.ts's
 * `normalize()`, the one place every ask/generate/streamEvents failure
 * passes through, so every provider and every caller gets this for free.
 */

export type ErrorCategory =
  | 'auth'
  | 'authorization'
  | 'billing'
  | 'rate_limit'
  | 'network'
  | 'model'
  | 'configuration'
  | 'server_error'
  | 'timeout'
  | 'no_provider'
  | 'unknown';

export interface TranslatedError {
  type: ErrorCategory;
  message: string;
  retryable: boolean;
}

/** Thrown by provider adapters on a non-2xx HTTP response — carries the raw
 * status and body so errorTranslator can classify by actual content, not
 * just the HTTP status (a 403 is "auth failed" for one provider and "no
 * credits" for another; the body is what tells them apart). */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly providerName: string;

  constructor(providerName: string, status: number, body: string) {
    super(`${providerName} error ${status}: ${body}`);
    this.name = 'ProviderHttpError';
    this.providerName = providerName;
    this.status = status;
    this.body = body;
  }
}

interface ParsedBody {
  code?: string;
  detailMessage?: string;
}

/**
 * Best-effort extraction of a machine code + human message from a
 * provider's response body. Handles the shapes actually seen in the wild:
 * OpenAI-style `{error:{message,type,code}}`, flatter `{code,message}`
 * bodies, a bare JSON string (Novita's `"NOT_ENOUGH_BALANCE"`), or plain
 * text. Never throws — worst case everything is undefined and
 * classification falls back to the HTTP status alone.
 */
function parseBody(body: string): ParsedBody {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    const j = JSON.parse(trimmed) as unknown;
    if (typeof j === 'string') return { code: j };
    if (j && typeof j === 'object') {
      const obj = j as Record<string, unknown>;
      const err = (obj.error && typeof obj.error === 'object') ? obj.error as Record<string, unknown> : obj;
      const code = [err.code, err.type, obj.code, obj.type].find((v): v is string => typeof v === 'string');
      const detailMessage = [err.message, obj.message].find((v): v is string => typeof v === 'string');
      return { code, detailMessage };
    }
    return {};
  } catch {
    return { detailMessage: trimmed.slice(0, 300) };
  }
}

// Keyword rules, checked against the parsed code + message together, in
// order — first match wins. Content is checked *before* falling back to
// the HTTP status because the same status means different things across
// providers: Novita reports "no credits" as a 403, not the 402 Payment
// Required a status-only classifier would expect.
const RULES: { pattern: RegExp; type: ErrorCategory }[] = [
  { pattern: /not.?enough.?balance|insufficient.?(credit|balance|fund)|no.?(remaining )?credit|payment.?required|out.?of.?credit/i, type: 'billing' },
  { pattern: /quota.?(exceeded|reached)|usage.?limit.?(exceeded|reached)|billing.?required|billing.?issue/i, type: 'billing' },
  { pattern: /rate.?limit|too.?many.?requests/i, type: 'rate_limit' },
  { pattern: /invalid.?api.?key|api.?key.?(is )?invalid|invalid.?token|expired.?(api.?)?key|api.?key.?expired|authentication.?fail/i, type: 'auth' },
  { pattern: /insufficient.?permission|access.?denied|forbidden|not.?allowed|not.?authorized.?to/i, type: 'authorization' },
  { pattern: /model.?not.?found|no.?such.?model|does.?not.?exist|unsupported.?model|unknown.?model/i, type: 'model' },
];

function classifyByContent(code?: string, message?: string): ErrorCategory | null {
  const haystack = [code, message].filter(Boolean).join(' ');
  if (!haystack) return null;
  for (const rule of RULES) if (rule.pattern.test(haystack)) return rule.type;
  return null;
}

/** Fallback when the body has no recognizable content — plain HTTP-status
 * semantics. Deliberately does NOT collapse 401 and 403 into one "auth"
 * bucket: 401 means the credential itself is bad, 403 means the request
 * was authenticated but rejected for another reason (permissions, or,
 * before content-based rules run, billing) — conflating them is what
 * produced "Authentication failed" for a balance error in the first place. */
function classifyByStatus(status: number): ErrorCategory {
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (status === 403) return 'authorization';
  if (status === 404) return 'model';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

const RETRYABLE: Record<ErrorCategory, boolean> = {
  auth: false,
  authorization: false,
  billing: false,
  rate_limit: true,
  network: true,
  model: false,
  configuration: false,
  server_error: true,
  timeout: true,
  no_provider: false,
  unknown: false,
};

function friendlyMessage(type: ErrorCategory, providerName: string, code: string | undefined, detailMessage: string | undefined): string {
  switch (type) {
    case 'billing':
      return `${providerName} account has no remaining credits.\n\nPlease recharge your ${providerName} account or switch to another AI provider.`;
    case 'auth':
      return `${providerName} rejected the API key.\n\nCheck that the key in Settings is correct and hasn't expired, or reconnect the provider.`;
    case 'authorization':
      return `${providerName} accepted the API key but rejected this request — it doesn't have permission for this action.\n\nCheck the key's permissions in your ${providerName} account.`;
    case 'rate_limit':
      return `${providerName} is rate-limiting requests right now.\n\nWait a moment and try again, or switch to another provider.`;
    case 'model':
      return `${providerName} doesn't recognize the selected model${code ? ` (${code})` : ''}.\n\nPick a different model in Settings.`;
    case 'server_error':
      return `${providerName} is having issues on its end.\n\nThis usually resolves itself — try again shortly.`;
    case 'network':
      return `Could not reach ${providerName}.\n\nCheck your network connection and try again.`;
    case 'timeout':
      return `The request to ${providerName} timed out.`;
    default:
      return detailMessage ? `${providerName} returned an error: ${detailMessage}` : `${providerName} returned an unexpected error.`;
  }
}

/** Classifies a `ProviderHttpError` (or equivalent raw status+body pair)
 * into a `TranslatedError` with a friendly, provider-labeled message —
 * never the raw JSON/text body. */
export function translateProviderError(providerName: string, status: number, rawBody: string): TranslatedError {
  const { code, detailMessage } = parseBody(rawBody);
  const type = classifyByContent(code, detailMessage) ?? classifyByStatus(status);
  return { type, message: friendlyMessage(type, providerName, code, detailMessage), retryable: RETRYABLE[type] };
}
