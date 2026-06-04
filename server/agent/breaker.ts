export type BreakerState = "closed" | "open";

export interface CircuitBreaker {
  readonly state: BreakerState;
  readonly failures: number;
  isOpen(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
  /** Force-close the breaker. Tests + admin restart use this; production never does. */
  reset(): void;
}

/**
 * Sticky N-strike breaker — exactly the shape the eng review settled on:
 * 3 consecutive HermesAgent failures and the breaker opens for the rest
 * of the server session, after which HermesAgent silently falls back to
 * MockAgent (subagent #9 — bound the blast radius of a wedged subprocess).
 *
 * "Sticky" means: once open, stays open until the process restarts (or a
 * test calls reset). No half-open / auto-recovery in v1 — keeps the
 * mental model simple and the failure surface unambiguous.
 */
export class CountingBreaker implements CircuitBreaker {
  private _failures = 0;
  private _opened = false;

  constructor(private readonly threshold: number = 3) {
    if (threshold < 1) throw new Error("breaker threshold must be >= 1");
  }

  get state(): BreakerState {
    return this._opened ? "open" : "closed";
  }
  get failures(): number {
    return this._failures;
  }
  isOpen(): boolean {
    return this._opened;
  }
  recordSuccess(): void {
    this._failures = 0;
  }
  recordFailure(): void {
    this._failures++;
    if (this._failures >= this.threshold) this._opened = true;
  }
  reset(): void {
    this._failures = 0;
    this._opened = false;
  }
}
