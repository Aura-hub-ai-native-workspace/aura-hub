/**
 * agentNarration — the one place backend vocabulary becomes English.
 * ==================================================================
 * The Central Agent speaks in event types (`worker.lifecycle`),
 * capability ids (`filesystem.write`), outcome enums
 * (`awaiting-approval`) and refusal reasons (`RESPONSE_UNCORRELATED`).
 * Every one of those is precise and none of them belongs in a
 * conversation. This module is the single translation table, so the
 * chat surface can render activity without any component learning what
 * an invocation is.
 *
 * Two rules hold everything here honest:
 *
 *   1. Nothing is invented. A label exists only for a signal the
 *      backend actually sent. An unknown event type returns null and
 *      shows nothing, rather than guessing a friendlier phase.
 *   2. Nothing is upgraded. "Verified" never stands in for "done", and
 *      a failure is never softened into a success — `outcomeSentence`
 *      keeps denied, timeout, blocked and failed distinct, because
 *      collapsing them is how a UI ends up claiming work that did not
 *      happen.
 */

/** What AURA is doing, for a compact one-line indicator. */
const EVENT_PHRASE: Array<[RegExp, string]> = [
  [/^session\.started$/, 'Thinking'],
  [/^intent\.compiled$/, 'Thinking'],
  [/^intent\.clarification-needed$/, 'Waiting for your reply'],
  [/^plan\.created$/, 'Working out the steps'],
  [/^capability\.discovery$/, 'Checking what it can use'],
  [/^authority\.checked$/, 'Checking what it is allowed to do'],
  [/^workflow\.(compiled|validated)$/, 'Working out the steps'],
  [/^execution\.started$/, 'Working'],
  [/^worker\.lifecycle$/, 'Working'],
  [/^worker\.action$/, 'Working'],
  [/^invocation\.observed$/, 'Working'],
  [/^approval\.required$/, 'Waiting for your approval'],
  [/^verification\.completed$/, 'Checking the result'],
  [/^answer\.(started|token)$/, 'Writing'],
  [/^result\.ready$/, 'Finishing up'],
  [/^agent\.(failed|cancelled)$/, 'Finishing up'],
  [/^run\.cancell/, 'Stopping'],
  [/^stream\.reconnecting$/, 'Reconnecting'],
];

/**
 * A short phrase for one event, or null when the event says nothing a
 * person needs. Unknown types are deliberately silent.
 */
export function eventPhrase(type: string): string | null {
  for (const [re, phrase] of EVENT_PHRASE) if (re.test(type)) return phrase;
  return null;
}

/**
 * Capability id → the thing a person would call it.
 *
 * Keyed on the id's own prefix so a new capability in the same family
 * reads correctly without an edit here, and an unrecognised family
 * falls back to nothing rather than to a guessed product name.
 */
const TOOL_NAME: Array<[RegExp, string]> = [
  [/^git\./, 'Git'],
  [/^github\./, 'GitHub'],
  [/^filesystem\./, 'your files'],
  [/^terminal\./, 'the terminal'],
  [/^http\./, 'the web'],
  [/^browser\./, 'a browser'],
  [/^workflow\./, 'your workflows'],
  [/^project\./, 'your projects'],
  [/^system\./, 'this machine'],
  [/^knowledge\./, 'the codebase index'],
  [/^memory\./, 'past decisions'],
];

/** A human name for a capability id, or null when there is no honest one. */
export function toolName(capabilityId: string | null | undefined): string | null {
  if (!capabilityId) return null;
  for (const [re, name] of TOOL_NAME) if (re.test(capabilityId)) return name;
  return null;
}

/** Joins names the way a sentence would: "a, b and c". */
export function joinNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export type OutcomeTone = 'neutral' | 'attention' | 'danger';

export interface OutcomeNote {
  tone: OutcomeTone;
  /** One plain sentence. Never an enum, never an id. */
  text: string;
}

/**
 * What a terminal outcome means, in words.
 *
 * `completed` returns null on purpose: a finished answer needs no
 * banner announcing that it finished. Everything else gets a sentence
 * that says what actually happened, and the distinctions the backend
 * draws are preserved rather than flattened into "failed".
 */
export function outcomeNote(outcome: string | null | undefined): OutcomeNote | null {
  switch (outcome) {
    case 'completed':
    case 'needs-clarification':
    case null:
    case undefined:
      return null;
    case 'awaiting-approval':
      return { tone: 'attention', text: 'This needs your approval before I continue.' };
    case 'denied':
      return { tone: 'attention', text: 'That action is not permitted here, so I stopped.' };
    case 'timeout':
      return { tone: 'attention', text: 'That took too long, so I stopped and changed nothing.' };
    case 'blocked':
      return { tone: 'attention', text: 'I could not start that, so nothing ran.' };
    case 'cancelled':
      return { tone: 'neutral', text: 'Stopped.' };
    case 'unsupported':
      return { tone: 'attention', text: 'I cannot do that on this machine yet.' };
    case 'failed':
      return { tone: 'danger', text: 'That did not work, so I have not marked it done.' };
    default:
      return { tone: 'danger', text: 'That did not finish.' };
  }
}

/**
 * Why a worker is not usable, in words.
 *
 * The backend's refusal reasons are precise and unreadable; each one
 * keeps its distinct meaning here. An unknown reason returns null so a
 * future code is never shown raw.
 */
const WORKER_REASON: Record<string, string> = {
  NOT_INSTALLED: 'not installed',
  RUNTIME_UNAVAILABLE: 'its runtime is not available',
  ADAPTER_UNKNOWN: 'AURA has no way to drive it',
  INVOCATION_FAILED: 'it could not be started',
  NO_RESPONSE: 'it did not answer',
  RESPONSE_UNCORRELATED: 'its answer could not be matched to the request',
  TIMEOUT: 'it did not answer in time',
  GOVERNANCE_UNSUPPORTED: 'it cannot be supervised safely',
};

export function workerReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return WORKER_REASON[reason] ?? null;
}

/**
 * A failure message a person can act on.
 *
 * Transport failures get the one explanation that matters. Anything
 * else is passed through, because the backend writes its refusals in
 * prose and rewording them here would be a second, quieter claim about
 * what went wrong.
 */
export function failureText(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text) return 'Something went wrong and I could not finish.';
  if (/failed to fetch|networkerror|load failed|connection refused|ECONNREFUSED/i.test(text)) {
    return 'I could not reach the AURA service. Check that it is running, then try again.';
  }
  return text;
}
