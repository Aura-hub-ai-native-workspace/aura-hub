import { describe, expect, it } from 'vitest';
import { failureText, outcomeNote } from './agentNarration';


describe('a legacy parked outcome is never shown as a failure', () => {
  it('reads as not started, neutral, with no approval wording', () => {
    const note = outcomeNote('awaiting-approval');
    expect(note?.tone).toBe('neutral');
    expect(note?.text).toBe('That did not start, so nothing ran.');
    expect(note?.text.toLowerCase()).not.toContain('approv');
  });
});

describe('a failure message names the real cause', () => {
  it('keeps an identity refusal specific, not the generic unreachable sentence', () => {
    const msg = 'Backend identity mismatch — connection refused. AURA did not start its own backend on port 4320.';
    expect(failureText(msg)).toBe(msg);
  });

  it('still words a genuine transport failure as unreachable', () => {
    expect(failureText('Failed to fetch')).toBe('I could not reach the AURA service. Check that it is running, then try again.');
  });
});
