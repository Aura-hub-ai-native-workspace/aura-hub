import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IsolationStatus } from '../../ai/centralAgentClient';
import { RunIsolationCard, activeBadge, imageLabel } from './RunIsolationCard';

function status(over: Partial<IsolationStatus>): IsolationStatus {
  return {
    setting: 'auto',
    settings: ['auto', 'container', 'host'],
    docker: { available: true, platformSupported: true, version: '29.9.3', reason: '' },
    image: { tag: 'aura-sandbox:abc', state: 'ready', detail: '' },
    active: 'container',
    reason: '',
    ...over,
  };
}

describe('Settings → AI Runtime → Run isolation', () => {
  it('offers the three settings in plain words', () => {
    const html = renderToStaticMarkup(<RunIsolationCard />);
    expect(html).toContain('Run isolation');
    expect(html).toContain('Automatic');
    expect(html).toContain('Container only');
    expect(html).toContain('This computer');
    expect(html).toContain('role="radiogroup"');
  });

  it('says what the next run will actually do', () => {
    expect(activeBadge(status({}))).toEqual({ tone: 'positive', label: 'Container' });
    expect(activeBadge(status({ active: 'host', docker: { available: false, platformSupported: true, version: '', reason: 'Docker is not installed.' } })))
      .toEqual({ tone: 'attention', label: 'This computer' });
    expect(activeBadge(status({ setting: 'host', active: 'host' })))
      .toEqual({ tone: 'neutral', label: 'This computer' });
    expect(activeBadge(status({ setting: 'container', active: 'refused' })))
      .toEqual({ tone: 'critical', label: 'Runs blocked' });
  });

  it('describes the image state', () => {
    expect(imageLabel(status({}))).toBe('Ready');
    expect(imageLabel(status({ image: { tag: 't', state: 'building', detail: '' } }))).toBe('Preparing…');
    expect(imageLabel(status({ image: { tag: 't', state: 'missing', detail: '' } }))).toBe('Not prepared');
    expect(imageLabel(status({ image: { tag: 't', state: 'failed', detail: 'x' } }))).toBe('Failed');
  });
});
