import type { ServerMessage } from "./types.ts";

export type ConnectionState = "connecting" | "open" | "closed";

export type MessageListener = (msg: ServerMessage) => void;
export type StateListener = (state: ConnectionState) => void;

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Resilient WebSocket client.
 *
 *   - exponential backoff up to MAX_BACKOFF_MS on close.
 *   - resets backoff on a successful open.
 *   - dispatches typed ServerMessages to subscribers.
 *   - separate subscription for connection state (so the UI can show a banner).
 *
 * Designed to be created once per app and held by a hook (T9 will wire one).
 */
export class DashboardWS {
  private ws: WebSocket | null = null;
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private currentState: ConnectionState = "closed";
  private nextBackoff = INITIAL_BACKOFF_MS;
  private shouldRun = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {}

  start(): void {
    if (this.shouldRun) return;
    this.shouldRun = true;
    this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.setState("closed");
  }

  /** Subscribe to incoming server messages. Returns an unsubscribe fn. */
  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Subscribe to connection-state changes. Returns an unsubscribe fn. */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // Emit current state immediately so new subscribers see the truth.
    listener(this.currentState);
    return () => this.stateListeners.delete(listener);
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  // ─── internals ─────────────────────────────────────────────────────

  private connect(): void {
    if (!this.shouldRun) return;
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.nextBackoff = INITIAL_BACKOFF_MS;
      this.setState("open");
    });

    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return; // ignore malformed frames
      }
      if (!isServerMessage(parsed)) return;
      for (const listener of this.messageListeners) {
        try {
          listener(parsed);
        } catch (err) {
          console.error("ws listener threw:", err);
        }
      }
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return; // we've already moved on (stop / reconnect)
      this.ws = null;
      if (!this.shouldRun) {
        this.setState("closed");
        return;
      }
      const delay = this.nextBackoff;
      this.nextBackoff = Math.min(this.nextBackoff * 2, MAX_BACKOFF_MS);
      this.setState("closed");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    });

    ws.addEventListener("error", () => {
      // Errors are followed by close — let close handle the backoff. We only
      // log here for visibility during dev.
      console.warn("ws error event");
    });
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("ws state listener threw:", err);
      }
    }
  }
}

function isServerMessage(x: unknown): x is ServerMessage {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { type?: unknown }).type;
  return t === "hello" || t === "file_event";
}
