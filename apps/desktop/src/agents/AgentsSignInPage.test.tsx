import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsSignInPage } from './AgentsSignInPage';

describe('agents sign-in page', () => {
  it('is a plain account page: heading, assurances, accounts card, one primary action', () => {
    const html = renderToStaticMarkup(<AgentsSignInPage onContinue={() => undefined} onSkip={() => undefined} />);
    expect(html).toContain('Sign in to your agents');
    expect(html).toContain('Your credentials stay on this device');
    expect(html).toContain('Accounts');
    expect(html).toContain('Checking your agents…');
    expect(html).toContain('Skip for now');
    expect(html).toContain('>Continue<');
  });
});
