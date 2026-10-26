import { describe, expect, it } from 'vitest';
import { CORS_ALLOW_HEADERS, decide, proofFor, TOKEN_HEADER } from './instanceGuard';

const TOKEN = 't'.repeat(32);
const C = 'c'.repeat(24);

describe('instance ownership (Node service)', () => {
  it('answers the proof for the launch token', () => {
    const d = decide('GET', '/instance/proof', {}, TOKEN, C);
    expect(d).toEqual({ kind: 'proof', status: 200, body: { backend: 'node', proof: proofFor(TOKEN, C) } });
  });

  it('a foreign service with another token cannot produce the expected proof', () => {
    const foreign = decide('GET', '/instance/proof', {}, 'f'.repeat(32), C);
    expect(foreign.kind === 'proof' && foreign.body.proof).not.toBe(proofFor(TOKEN, C));
  });

  it('a proof is bound to its challenge', () => {
    expect(proofFor(TOKEN, C)).not.toBe(proofFor(TOKEN, 'd'.repeat(24)));
  });

  it('refuses a malformed or missing challenge', () => {
    expect(decide('GET', '/instance/proof', {}, TOKEN, 'short')).toMatchObject({ kind: 'proof', status: 400 });
    expect(decide('GET', '/instance/proof', {}, TOKEN, null)).toMatchObject({ kind: 'proof', status: 400 });
  });

  it('refuses state-changing and read requests that do not carry the token', () => {
    expect(decide('POST', '/workflows', {}, TOKEN, null)).toMatchObject({ kind: 'refused', status: 401 });
    expect(decide('GET', '/workflows', { [TOKEN_HEADER]: 'nope' }, TOKEN, null)).toMatchObject({ kind: 'refused' });
  });

  it('admits a request that presents the right token', () => {
    expect(decide('POST', '/workflows', { [TOKEN_HEADER]: TOKEN }, TOKEN, null)).toEqual({ kind: 'open' });
  });

  it('keeps health open, so liveness is separate from ownership', () => {
    expect(decide('GET', '/health', {}, TOKEN, null)).toEqual({ kind: 'open' });
  });

  it('is inert when no token is configured', () => {
    expect(decide('POST', '/workflows', {}, '', null)).toEqual({ kind: 'open' });
    expect(decide('GET', '/instance/proof', {}, '', C)).toMatchObject({ body: { proof: null } });
  });

  it('never echoes the token in a body', () => {
    for (const d of [
      decide('GET', '/instance/proof', {}, TOKEN, C),
      decide('GET', '/workflows', {}, TOKEN, null),
    ]) expect(JSON.stringify(d)).not.toContain(TOKEN);
  });

  it('allows the token header in the CORS preflight, or the webview can never send it', () => {
    expect(CORS_ALLOW_HEADERS.split(',').map((h) => h.trim())).toContain(TOKEN_HEADER);
  });
});
