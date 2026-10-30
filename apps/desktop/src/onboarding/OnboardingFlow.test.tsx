import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnboardingFlow } from './OnboardingFlow';

/** A returning person without a usable provider opens at activation, not the welcome. */
describe('OnboardingFlow start step', () => {
  it('a first run opens on the welcome screen', () => {
    const html = renderToStaticMarkup(<OnboardingFlow onComplete={() => undefined} />);
    expect(html).toContain('Welcome to AURA');
  });
  it('a returning person missing a provider opens at activation, not the welcome again', () => {
    const html = renderToStaticMarkup(<OnboardingFlow initialStep="activate" onComplete={() => undefined} />);
    expect(html).not.toContain('Welcome to AURA');
    expect(html).toContain('Connect your Ollama server');
  });
});
