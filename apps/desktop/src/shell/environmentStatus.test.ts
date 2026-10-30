import { describe, expect, it } from 'vitest';
import { homeEnvironmentLabel, pythonStatusLabel } from './environmentStatus';

describe('the environment is only ready when the Python backend is', () => {
  it('reads ready only when the Node service and the Python backend are both up', () => {
    expect(homeEnvironmentLabel({ nodeReachable: true, pythonOk: true, pythonMessage: null })).toBe('Environment ready');
  });

  it('is not ready when the Python backend is unavailable, even though the Node service answers', () => {
    expect(homeEnvironmentLabel({ nodeReachable: true, pythonOk: false, pythonMessage: 'not running' }))
      .toBe('Environment not ready');
  });

  it('is not ready when the Python backend identity is refused', () => {
    const f = { nodeReachable: true, pythonOk: false, pythonMessage: 'Backend identity mismatch — connection refused. x' };
    expect(homeEnvironmentLabel(f)).toBe('Environment not ready');
    expect(pythonStatusLabel(f)).toBe('Environment backend: identity mismatch, connection refused');
  });

  it('never reports ready while either fact is unknown', () => {
    expect(homeEnvironmentLabel({ nodeReachable: null, pythonOk: null, pythonMessage: null })).toBe('Checking the environment…');
    expect(homeEnvironmentLabel({ nodeReachable: true, pythonOk: null, pythonMessage: null })).toBe('Checking the environment…');
    expect(pythonStatusLabel({ pythonOk: null, pythonMessage: null })).toBe('Environment: checking');
  });

  it('reports an offline Node service as offline, whatever the Python state', () => {
    expect(homeEnvironmentLabel({ nodeReachable: false, pythonOk: true, pythonMessage: null })).toBe('Backend offline');
  });
});
