/**
 * What the shell may say about the environment, derived from two separate facts:
 *
 *  - the Node service's health (`nodeReachable`), and
 *  - the Python backend's availability and ownership (`pythonOk`).
 *
 * "Environment ready" needs both. The Node service answering says nothing about
 * the Python backend that inventories the machine, so it can never be enough on
 * its own. Unknown is reported as unknown, never as ready.
 */
export interface EnvironmentFacts {
  nodeReachable: boolean | null;
  pythonOk: boolean | null;
  /** The Python backend's own message when it is not usable (for example an identity refusal). */
  pythonMessage: string | null;
}

export function homeEnvironmentLabel(f: EnvironmentFacts): string {
  if (f.nodeReachable === false) return 'Backend offline';
  if (f.nodeReachable === null || f.pythonOk === null) return 'Checking the environment…';
  if (!f.pythonOk) return 'Environment not ready';
  return 'Environment ready';
}

export function pythonStatusLabel(f: Pick<EnvironmentFacts, 'pythonOk' | 'pythonMessage'>): string {
  if (f.pythonOk === null) return 'Environment: checking';
  if (f.pythonOk) return 'Environment: connected';
  if (f.pythonMessage && /identity mismatch/i.test(f.pythonMessage)) {
    return 'Environment backend: identity mismatch, connection refused';
  }
  return 'Environment backend: not connected';
}
