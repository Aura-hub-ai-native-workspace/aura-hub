import { describe, expect, it } from 'vitest';
import { detectConnection } from './detectConnection';

/**
 * The classifier's whole job is to describe an address honestly, so the
 * cases that matter most are the ones where it must NOT claim to know:
 * a bare hostname, and anything malformed.
 */
describe('detectConnection', () => {
  it.each([
    ['http://localhost:11434'],
    ['http://127.0.0.1:11434'],
    ['http://127.0.0.2:11434'],
    ['http://[::1]:11434'],
    ['localhost:11434'],
  ])('reads %s as this machine', (url) => {
    expect(detectConnection(url).kind).toBe('this-machine');
  });

  it.each([
    ['http://192.168.1.50:11434'],
    ['http://10.0.0.20:11434'],
    ['http://172.16.0.20:11434'],
    ['http://172.31.255.1:11434'],
  ])('reads %s as another machine on the network', (url) => {
    expect(detectConnection(url).kind).toBe('lan');
  });

  it('does not treat 172.32.x as private — the block ends at 172.31', () => {
    expect(detectConnection('http://172.32.0.1:11434').kind).toBe('remote');
  });

  it.each([
    ['http://203.0.113.10:11434'],
    ['https://ollama.example.com'],
    ['https://somehow-video-harbor-frederick.trycloudflare.com'],
  ])('reads %s as a remote server', (url) => {
    expect(detectConnection(url).kind).toBe('remote');
  });

  it('will not guess a location from a bare hostname', () => {
    const d = detectConnection('http://gpu-node-7:11434');
    expect(d.kind).toBe('unknown');
    expect(d.label).toMatch(/confirmed during verification/i);
  });

  it('rejects a malformed URL', () => {
    expect(detectConnection('http://').kind).toBe('invalid');
    expect(detectConnection('ht!tp://x').kind).not.toBe('remote');
  });

  it('asks for an address when the field is empty', () => {
    expect(detectConnection('').kind).toBe('unknown');
    expect(detectConnection('   ').label).toMatch(/Enter the address/i);
  });

  it('never reports a private address as public', () => {
    for (const host of ['10.255.255.255', '192.168.0.1', '172.16.0.1']) {
      expect(detectConnection(`http://${host}:11434`).kind).toBe('lan');
    }
  });
});
