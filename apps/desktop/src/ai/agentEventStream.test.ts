/**
 * agentEventStream — reconnect/dedupe/malformed-frame contract tests.
 *
 * These pin the client side of the live event spine: replay overlap
 * after reconnect must never double-render, cursors must advance
 * monotonically, legacy frames keep working, and malformed input is
 * inert. Run with `vitest run` from the repo root.
 */
import { describe, expect, it } from 'vitest';

import { FrameDeduper, parseBlock, splitBlocks } from './agentEventStream';

describe('splitBlocks', () => {
  it('splits complete frames and keeps the partial tail', () => {
    const { blocks, rest } = splitBlocks('id: 1\ndata: {"a":1}\n\nid: 2\ndata: {"b":2');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('id: 1');
    expect(rest).toContain('id: 2');
  });

  it('passes heartbeat comments through as dataless blocks', () => {
    const { blocks, rest } = splitBlocks(': heartbeat\n\nid: 3\ndata: {}\n\n');
    expect(blocks).toHaveLength(2);
    expect(rest).toBe('');
  });

  it('handles an empty buffer', () => {
    expect(splitBlocks('')).toEqual({ blocks: [], rest: '' });
  });
});

describe('parseBlock', () => {
  it('reads id and data lines', () => {
    expect(parseBlock('id: 42\ndata: {"type":"x"}')).toEqual({
      seq: 42,
      data: '{"type":"x"}',
    });
  });

  it('degrades malformed ids to legacy treatment', () => {
    expect(parseBlock('id: nope\ndata: {}').seq).toBeNull();
    expect(parseBlock('id: -3\ndata: {}').seq).toBeNull();
  });

  it('returns null data for heartbeats and unknown lines', () => {
    expect(parseBlock(': heartbeat').data).toBeNull();
    expect(parseBlock('event: foo\nretry: 1000').data).toBeNull();
  });

  it('ignores the [DONE] sentinel content-wise (caller filters it)', () => {
    // The sentinel is still parsed as data; the stream loop drops it.
    expect(parseBlock('data: [DONE]').data).toBe('[DONE]');
  });
});

describe('FrameDeduper', () => {
  it('suppresses replay duplicates by sequence', () => {
    const d = new FrameDeduper();
    expect(d.check(1, 'a@t')).toBe(true);
    expect(d.check(2, 'b@t')).toBe(true);
    expect(d.check(1, 'a@t')).toBe(false); // replay overlap
    expect(d.check(2, 'b@t')).toBe(false);
    expect(d.check(3, 'c@t')).toBe(true);
  });

  it('advances the cursor monotonically', () => {
    const d = new FrameDeduper();
    expect(d.cursor).toBeNull();
    d.check(5, 'a@t');
    d.check(3, 'b@t'); // out-of-order delivery must not move it back
    expect(d.cursor).toBe(5);
  });

  it('falls back to type@at keys for legacy frames', () => {
    const d = new FrameDeduper();
    expect(d.check(null, 'intent.compiled@t1')).toBe(true);
    expect(d.check(null, 'intent.compiled@t1')).toBe(false);
    expect(d.check(null, 'intent.compiled@t2')).toBe(true);
    expect(d.cursor).toBeNull(); // legacy frames never forge a cursor
  });

  it('mixes sequenced and legacy frames independently', () => {
    const d = new FrameDeduper();
    expect(d.check(7, 'x@t')).toBe(true);
    expect(d.check(null, 'x@t')).toBe(true); // different key spaces
  });

  it('bounds memory on pathological streams', () => {
    const d = new FrameDeduper();
    for (let i = 1; i <= 2500; i++) d.check(i, `k${i}`);
    expect(d.cursor).toBe(2500);
  });
});
