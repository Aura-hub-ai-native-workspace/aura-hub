import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpecialistRoster } from './SpecialistRoster';
import type { Specialist } from '../../../ai/workerClient';

const make = (id: string, name: string, runtime: string, runtimeName: string, runtimeAvailable: boolean | null): Specialist =>
  ({ id, name, runtime, runtimeName, runtimeAvailable, focus: `${name} focus`, responsibilities: [] });

describe('SpecialistRoster', () => {
  it('shows each agent with its runtime and the real availability of that runtime', () => {
    const html = renderToStaticMarkup(<SpecialistRoster specialists={[
      make('researcher', 'Researcher', 'opencode', 'OpenCode', true),
      make('debugger', 'Debugger', 'kilo-code', 'Kilo Code', false),
      make('planner', 'Planner', 'opencode', 'OpenCode', null),
    ]} />);
    expect(html).toMatch(/data-testid="specialist-researcher" data-state="ready"/);
    expect(html).toContain('on OpenCode');
    expect(html).toMatch(/data-testid="specialist-debugger" data-state="unavailable"/);
    expect(html).toContain('Kilo Code not connected');
    // Unknown is shown as unknown, never as ready.
    expect(html).toMatch(/data-testid="specialist-planner" data-state="unknown"/);
  });

  it('says so when the roster could not be read, and shows nothing when it is empty', () => {
    expect(renderToStaticMarkup(<SpecialistRoster specialists={[]} error="request failed (500)" />)).toContain('request failed (500)');
    expect(renderToStaticMarkup(<SpecialistRoster specialists={[]} />)).toBe('');
  });
});
