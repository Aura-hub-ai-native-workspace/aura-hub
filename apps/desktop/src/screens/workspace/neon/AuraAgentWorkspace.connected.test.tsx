import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuraAgentWorkspace } from './AuraAgentWorkspace';

describe('workspace header', () => {
  it('shows only connected or working agents at the top', () => {
    const html = renderToStaticMarkup(
      <AuraAgentWorkspace
        {...({ groupTitle: 'Shop', railOpen: false, onToggleRail: () => undefined, agentUp: true, composer: null,
          messages: [], frames: [], busy: false, onSend: () => undefined, onRegenerate: () => undefined, handoffs: [], onAcceptHandoff: () => undefined,
          members: [
            { id: 'opencode', name: 'OpenCode', tone: 'ready' },
            { id: 'kilo-code', name: 'Kilo Code', tone: 'working' },
            { id: 'claude-code', name: 'Claude Code', tone: 'idle' },
            { id: 'codex-cli', name: 'Codex', tone: 'idle' },
          ] } as unknown as Parameters<typeof AuraAgentWorkspace>[0])}
      />,
    );
    const strip = html.slice(html.indexOf('data-testid="connected-members"'));
    expect(strip).toContain('OpenCode · ready');
    expect(strip).toContain('Kilo Code · working');
    expect(strip).not.toContain('Claude Code');
    expect(strip).not.toContain('Codex');
  });
});
