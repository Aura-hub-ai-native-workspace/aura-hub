import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StorageTab, formatBytes } from './StorageTab';

describe('Settings → Storage', () => {
  it('formats sizes the way people read them', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(943 * 1024 * 1024)).toBe('943 MB');
    expect(formatBytes(17 * 1024 ** 3)).toBe('17.0 GB');
  });

  it('measures first and offers a clean-up that keeps user data', () => {
    const html = renderToStaticMarkup(<StorageTab />);
    expect(html).toContain('Measuring…');
    expect(html).toContain('Clean up');
    expect(html).toContain('Conversations, memory and');
  });
});
