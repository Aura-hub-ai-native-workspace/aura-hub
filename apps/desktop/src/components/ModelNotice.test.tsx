import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelNotice } from './GeneralChat';

const status = (laya: object) => ({ laya: { providers: [], note: '', ...laya }, local: {}, recommendation: null }) as never;
const html = (s: never) => renderToStaticMarkup(<ModelNotice status={s} />);

describe('ModelNotice tells the three model states apart', () => {
  it('nothing configured', () => {
    const h = html(status({ configured: false, usable: false }));
    expect(h).toContain('data-testid="no-model"');
    expect(h).toContain('No reasoning model is configured');
  });
  it('selected in Settings but not callable by the Central Agent: says why, not "none configured"', () => {
    const h = html(status({ configured: false, usable: false, settings: { configured: true, callable: false }, note: 'A provider is selected in Settings, but the Central Agent cannot call it: needs-api-key' }));
    expect(h).toContain('needs-api-key');
    expect(h).not.toContain('No reasoning model is configured');
  });
  it('configured but unreachable: its own notice, with the measured reason', () => {
    const h = html(status({ configured: true, usable: false, note: 'A model is configured but AURA cannot use it right now: ollama — unreachable (URLError).' }));
    expect(h).toContain('data-testid="model-unusable"');
    expect(h).toContain('unreachable');
    expect(h).not.toContain('data-testid="no-model"');
  });
  it('usable: no model warning at all', () => {
    const h = html(status({ configured: true, usable: true }));
    expect(h).not.toContain('no-model');
    expect(h).not.toContain('model-unusable');
  });
});
