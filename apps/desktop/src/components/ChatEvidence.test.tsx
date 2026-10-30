import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResearchNotice, SourceList } from './ChatEvidence';

const render = (research: Parameters<typeof ResearchNotice>[0]['research']) => renderToStaticMarkup(<ResearchNotice research={research} />);

describe('ResearchNotice', () => {
  it('offers the search-gateway form only when none is configured', () => {
    const html = render({ status: 'unavailable', detail: 'No search gateway is configured', kind: 'not-configured', consulted: 0, cited: 0 } as never);
    expect(html).toContain('data-testid="search-gateway-form"');
    expect(html).toContain('Test and save');
    expect(html).toContain('not backed by sources');
  });

  it('does not offer it for a gateway that exists but failed, and never suggests an engine', () => {
    for (const kind of ['timeout', 'refused', 'failed'] as const) {
      const html = render({ status: 'unavailable', detail: 'x', kind, consulted: 0, cited: 0 } as never);
      expect(html).not.toContain('search-gateway-form');
    }
    const html = render({ status: 'unavailable', detail: '', kind: 'not-configured', consulted: 0, cited: 0 } as never);
    expect(html).not.toMatch(/google|bing|duckduckgo|brave|serp/i);
  });

  it('says nothing when research worked or was skipped', () => {
    expect(render({ status: 'ok', detail: '', consulted: 2, cited: 1 } as never)).toBe('');
    expect(render({ status: 'skipped', detail: '', consulted: 0, cited: 0 } as never)).toBe('');
  });

  it('an empty search is its own message, not an outage', () => {
    const html = render({ status: 'empty', detail: '', consulted: 0, cited: 0 } as never);
    expect(html).toContain('found nothing');
    expect(html).not.toContain('search-gateway-form');
  });
});

describe('SourceList', () => {
  const src = [{ id: 1, title: 'PEP 8', url: 'https://peps.python.org/pep-0008/', retrievedAt: 't' }] as never;
  it('lists consulted sources when nothing was cited, and says so', () => {
    const html = renderToStaticMarkup(<SourceList cited={[]} consulted={src} />);
    expect(html).toContain('not cited in this answer');
    expect(html).toContain('peps.python.org');
    expect(html).not.toContain('Sources cited<');
  });
  it('shows nothing when no source was consulted', () => {
    expect(renderToStaticMarkup(<SourceList cited={[]} consulted={[]} />)).toBe('');
  });
});
