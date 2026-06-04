import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";

export type FileEventType = "add" | "change" | "unlink";

export type FileEvent = {
  type: FileEventType;
  path: string;
  relPath: string;
  /** Best-effort modification time in ms since epoch. */
  mtimeMs: number;
};

type SuppressEntry = { until: number };

/**
 * Watches a vault directory for *.md changes and emits typed events.
 *
 * Two important behaviors set by /plan-eng-review:
 *
 * 1. *.tmp.* files are ignored (atomic-write staging path; never a real event).
 *
 * 2. Server-originated writes are suppressed via `suppressNext(path)`. Without
 *    this, the server's own atomic rename echoes back through chokidar and
 *    overwrites the client's optimistic UI state (subagent #1 — watcher echo).
 */
export class VaultWatcher {
  private watcher: FSWatcher | null = null;
  private listeners: Set<(e: FileEvent) => void> = new Set();
  private suppress: Map<string, SuppressEntry> = new Map();

  constructor(private readonly vaultPath: string) {}

  start(): Promise<void> {
    if (this.watcher) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = chokidar.watch(this.vaultPath, {
        ignored: (filePath: string) =>
          filePath.includes(".tmp.") || /(^|\/)\.[^/]+/.test(filePath),
        ignoreInitial: true,
        // awaitWriteFinish prevents emitting half-written files. The tight
        // threshold keeps reaction latency snappy for human edits while
        // still avoiding partial reads on slow disks.
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
        persistent: true,
      });

      const dispatch = (type: FileEventType) => (filePath: string, stats?: { mtimeMs?: number }) => {
        if (!filePath.endsWith(".md")) return;
        if (this.consumeSuppress(filePath)) return;
        const evt: FileEvent = {
          type,
          path: filePath,
          relPath: relative(this.vaultPath, filePath),
          mtimeMs: stats?.mtimeMs ?? Date.now(),
        };
        for (const l of this.listeners) {
          try {
            l(evt);
          } catch {
            /* listener errors must not break the watcher */
          }
        }
      };

      w.on("add", dispatch("add"));
      w.on("change", dispatch("change"));
      w.on("unlink", dispatch("unlink"));
      w.on("error", (err) => {
        if (!this.watcher) return; // already stopping
        // chokidar surfaces stat / EPERM errors here; log via console.error
        // (the server's structured logger isn't a dependency of this class).
        console.error("VaultWatcher error:", err);
      });
      w.on("ready", () => {
        this.watcher = w;
        resolve();
      });

      // Reject if the initial scan errors out before "ready".
      const failFast = (err: unknown) => {
        if (this.watcher) return;
        w.close().finally(() => reject(err));
      };
      w.once("error", failFast);
    });
  }

  async stop(): Promise<void> {
    const w = this.watcher;
    this.watcher = null;
    this.listeners.clear();
    this.suppress.clear();
    if (w) await w.close();
  }

  /** Subscribe to file events. Returns an unsubscribe fn. */
  on(handler: (e: FileEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Drop the next event for `path` if it lands within `windowMs`.
   * Call this immediately BEFORE a server-originated atomic write.
   */
  suppressNext(path: string, windowMs = 500): void {
    this.suppress.set(path, { until: Date.now() + windowMs });
  }

  private consumeSuppress(path: string): boolean {
    const entry = this.suppress.get(path);
    if (!entry) return false;
    if (Date.now() <= entry.until) {
      this.suppress.delete(path);
      return true;
    }
    // Stale entry — clear and don't suppress.
    this.suppress.delete(path);
    return false;
  }
}
