import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GoogleButton } from './GoogleAccount';
import { GoogleSignInPage } from './GoogleSignInPage';
import { CloudControls } from './CloudControls';
import { formatBytes } from './cloudClient';

describe('Google sign-in and cloud UI', () => {
  it('uses Google’s standard button wording', () => {
    expect(renderToStaticMarkup(<GoogleButton onClick={() => undefined} />)).toContain('Continue with Google');
  });
  it('the first-launch page is optional and explains the one browser step', () => {
    const html = renderToStaticMarkup(<GoogleSignInPage onContinue={() => undefined} />);
    expect(html).toContain('Sign in to AURA Hub');
    expect(html).toContain('Skip for now');
    expect(html).toContain('Your browser opens once');
  });
  it('the project action says “Send to cloud”', () => {
    const html = renderToStaticMarkup(<CloudControls projectId="p1" />);
    expect(html).toContain('Send to cloud');
    expect(html).not.toMatch(/Save to Google/i);
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
