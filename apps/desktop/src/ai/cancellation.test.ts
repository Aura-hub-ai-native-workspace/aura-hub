/**
 * The four things a Stop can have done (F-24), classified from what the
 * services really answer. Both service clients return the response body
 * whatever the HTTP status, so a refusal is an `{ error }` object and a
 * transport failure is a thrown error; neither may read as "cancelled".
 *
 * Run with `npm run test:front` from the repo root.
 */
import { describe, expect, it } from 'vitest';
import {
  cancelTransportFailure, classifyAutomationCancel, classifyWorkflowCancel, describeTransportFailure, finishedState,
  reconcileAutomationCancel,
} from './cancellation';

describe('workflow run cancel answers', () => {
  it('a landed request is "requested", never "confirmed"', () => {
    expect(classifyWorkflowCancel({ cancelled: true }).kind).toBe('requested');
  });
  it.each([
    ['succeeded', 'that run already succeeded — there is nothing to cancel'],
    ['failed', 'that run already failed — there is nothing to cancel'],
  ])('a run that already %s is reported as finished, with its real state', (state, error) => {
    const r = classifyWorkflowCancel({ error });
    expect(r).toMatchObject({ kind: 'already-finished', state });
    expect(r.message).toContain(state);
  });
  it('an unknown run, an unsignalled run and an unreadable answer are failures', () => {
    expect(classifyWorkflowCancel({ error: 'not found' }).kind).toBe('failed');
    expect(classifyWorkflowCancel({ cancelled: false }).kind).toBe('failed');
    expect(classifyWorkflowCancel(null).kind).toBe('failed');
    expect(classifyWorkflowCancel('ok').kind).toBe('failed');
  });
  it('a failure says the run is still running', () => {
    expect(classifyWorkflowCancel({ error: 'not found' }).message).toMatch(/still running/i);
  });
});

describe('automation run cancel answers', () => {
  it("the engine's own record decides: cancelled confirms", () => {
    expect(classifyAutomationCancel({ id: 'r1', status: 'cancelled' }).kind).toBe('confirmed');
  });
  it.each(['completed', 'failed'])('a run that is already %s is finished, not cancelled', (status) => {
    expect(classifyAutomationCancel({ id: 'r1', status })).toMatchObject({ kind: 'already-finished', state: status });
  });
  it('a 409 for a finished run is reported as that, not as a missing run', () => {
    expect(classifyAutomationCancel({ error: 'that run already completed — there is nothing to cancel' }))
      .toMatchObject({ kind: 'already-finished', state: 'completed' });
  });
  it('not found, a still-running record and an unreadable answer are failures', () => {
    expect(classifyAutomationCancel({ error: 'not found' }).kind).toBe('failed');
    expect(classifyAutomationCancel({ id: 'r1', status: 'running' }).kind).toBe('failed');
    expect(classifyAutomationCancel(undefined).kind).toBe('failed');
  });
});

describe('transport failures and run records', () => {
  it('a thrown error is a failure that says the run is unchanged', () => {
    const r = cancelTransportFailure(new TypeError('Failed to fetch'));
    expect(r.kind).toBe('failed');
    expect(r.message).toMatch(/could not be reached/i);
    expect(r.message).toMatch(/still running/i);
  });
  it('keeps a specific message and has a fallback', () => {
    expect(describeTransportFailure(new Error('backend identity mismatch'))).toBe('backend identity mismatch');
    expect(describeTransportFailure(new Error(''))).toBe('The request failed.');
  });
  it.each([['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'cancelled'], ['timed-out', 'timed-out']])(
    'finishedState reads %s as finished', (state, expected) => {
      expect(finishedState({ state })).toBe(expected);
    });
  it.each([['running'], ['queued'], [undefined]])('finishedState does not read %s as finished', (state) => {
    expect(finishedState({ state })).toBeNull();
    expect(finishedState(null)).toBeNull();
  });
});

describe('reconciling an automation refusal with the run record', () => {
  const refused = classifyAutomationCancel({ error: 'no such run' });
  it.each(['completed', 'failed'])('a run whose record says %s is reported as finished', (status) => {
    expect(reconcileAutomationCancel(refused, { status })).toMatchObject({ kind: 'already-finished', state: status });
  });
  it('a run whose record says cancelled is reported as already cancelled', () => {
    expect(reconcileAutomationCancel(refused, { status: 'cancelled' }).message).toMatch(/already cancelled/i);
  });
  it('a record that is still active, or missing, leaves the failure alone', () => {
    expect(reconcileAutomationCancel(refused, { status: 'running' })).toBe(refused);
    expect(reconcileAutomationCancel(refused, null)).toBe(refused);
  });
  it('never touches a result that is not a failure', () => {
    const confirmed = classifyAutomationCancel({ status: 'cancelled' });
    expect(reconcileAutomationCancel(confirmed, { status: 'completed' })).toBe(confirmed);
  });

  it('a cancelled run whose action is still winding down is "requested", not "confirmed"', () => {
    const r = classifyAutomationCancel({ status: 'cancelled', cancellation: { phase: 'winding-down', actionId: 'a1', label: 'Run workflow' } });
    expect(r.kind).toBe('requested');
    expect(r.message).toMatch(/still winding down/);
    expect(r.message).toMatch(/Run workflow/);
    expect(r.message).toMatch(/not undone/);
  });
  it('only an explicit complete phase claims nothing is still running', () => {
    expect(classifyAutomationCancel({ status: 'cancelled', cancellation: { phase: 'complete' } }).message).toMatch(/nothing of it is still running/);
    expect(classifyAutomationCancel({ status: 'cancelled' }).message).not.toMatch(/still running/);   // a legacy record says no more than it knows
  });
});
