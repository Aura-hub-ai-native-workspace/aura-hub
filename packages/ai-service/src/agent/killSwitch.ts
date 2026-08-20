/**
 * agent/killSwitch — stop, and stay stopped.
 * ==================================================================
 * Three obligations, in this order:
 *
 *   1. HALT      no further model turn and no further tool call begins.
 *   2. CANCEL    work already in flight is abandoned by the loop.
 *   3. REFUSE    new runs are refused until a human re-arms it.
 *
 * (3) is the one that is usually missing. A switch that stops the current
 * run and lets the next one start is a cancel button, and the situation
 * that makes someone reach for a kill switch is almost never resolved by
 * the time the next run wants to begin.
 *
 * What "cancel" honestly means here is worth stating, because overstating
 * it would be the more dangerous error. The loop stops awaiting an
 * in-flight invocation immediately and records its step as `unknown` —
 * the outcome that exists precisely for "it may or may not have taken
 * effect". The invocation itself continues inside the Fabric, under the
 * Fabric's own bounds, and writes its own audit record when it settles.
 * The alternative would be a cancellation port into the execution
 * authority, which is a second way to interrupt an executor and therefore
 * exactly the kind of duplicate this codebase refuses.
 */

export interface KillReport {
  halted: boolean;
  at: string | null;
  by: string | null;
  reason: string | null;
}

export class KillSwitch {
  private controller = new AbortController();
  private haltedAt: string | null = null;
  private haltedBy: string | null = null;
  private haltReason: string | null = null;
  private listeners = new Set<(report: KillReport) => void>();

  /** True while the switch is pulled. New work is refused. */
  get halted(): boolean {
    return this.haltedAt !== null;
  }

  /**
   * Aborts the moment the switch is pulled.
   *
   * Handed to the provider call so a model request in flight is torn down
   * rather than waited out — a 30-second generate is 30 seconds of a
   * halted loop still burning budget otherwise.
   */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  report(): KillReport {
    return { halted: this.halted, at: this.haltedAt, by: this.haltedBy, reason: this.haltReason };
  }

  /**
   * Pull the switch. Idempotent: pulling it again keeps the FIRST reason,
   * because the first one is the one that explains why everything after
   * it stopped.
   */
  trip(by: string, reason: string): KillReport {
    if (!this.halted) {
      this.haltedAt = new Date().toISOString();
      this.haltedBy = by;
      this.haltReason = reason;
      this.controller.abort();
      const report = this.report();
      for (const listener of this.listeners) {
        try { listener(report); } catch { /* a listener must not keep the loop alive */ }
      }
    }
    return this.report();
  }

  /**
   * Re-arm, so runs may start again.
   *
   * Takes who did it because re-arming is a decision, and a decision with
   * no name attached is indistinguishable from the software deciding it
   * had waited long enough. A fresh `AbortController` is installed here —
   * reusing an aborted one would leave every subsequent run pre-cancelled.
   */
  rearm(by: string): KillReport {
    this.haltedAt = null;
    this.haltedBy = by;
    this.haltReason = null;
    this.controller = new AbortController();
    return this.report();
  }

  /** Notified once, when the switch is pulled. */
  onTrip(listener: (report: KillReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * The process-wide switch.
 *
 * One switch, deliberately: a per-run switch would mean a person hitting
 * stop has to hit it once per run, and would not stop the run that starts
 * a second later. The thing being armed is AURA's permission to act on
 * its own, and that is a single fact about the machine.
 */
export const KILL_SWITCH = new KillSwitch();
