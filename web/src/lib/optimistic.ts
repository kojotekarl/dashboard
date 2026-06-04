/**
 * Tracks contentHashes we've already applied locally (from our own PATCH /
 * approve / dismiss responses) so that when the server's WebSocket fires a
 * file_event echoing one of those writes, we drop it instead of fighting our
 * own optimistic UI state.
 *
 * Pairs with the server-side `watcher.suppressNext()` window: the server
 * suppression is the fast path (most echoes never reach the wire); this
 * tracker is the safety net for the rare event that escapes the suppression
 * window.
 *
 * Decided in /plan-eng-review (subagent #2 — version-token precedence).
 */
export class OptimisticTracker {
  private readonly seen = new Set<string>();
  private readonly insertionOrder: string[] = [];

  constructor(private readonly maxSize: number = 200) {}

  /** Record a contentHash we've just applied locally. */
  record(contentHash: string): void {
    if (this.seen.has(contentHash)) return;
    this.seen.add(contentHash);
    this.insertionOrder.push(contentHash);
    if (this.insertionOrder.length > this.maxSize) {
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** True if an incoming file_event carries a contentHash we already know. */
  isEcho(contentHash: string | undefined): boolean {
    if (contentHash === undefined) return false;
    return this.seen.has(contentHash);
  }

  /** Test/debug accessor. */
  get size(): number {
    return this.seen.size;
  }
}
