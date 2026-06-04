import type { ServerWebSocket } from "bun";
import type { FileEvent } from "./watcher.ts";

export type BroadcastMessage =
  | { type: "hello"; clients: number }
  | { type: "file_event"; event: { kind: FileEvent["type"]; relPath: string; mtimeMs: number } };

export class WebSocketBroadcaster {
  private readonly clients = new Set<ServerWebSocket<unknown>>();

  add(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws);
  }

  remove(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws);
  }

  broadcast(message: BroadcastMessage): void {
    const json = JSON.stringify(message);
    for (const ws of this.clients) {
      try {
        ws.send(json);
      } catch {
        // Client closed mid-send; .close handler will remove it.
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }
}

/** Convert a watcher event into the wire shape sent over the socket. */
export function fileEventToMessage(e: FileEvent): BroadcastMessage {
  return {
    type: "file_event",
    event: { kind: e.type, relPath: e.relPath, mtimeMs: e.mtimeMs },
  };
}
