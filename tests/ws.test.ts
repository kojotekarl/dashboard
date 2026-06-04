import type { ServerWebSocket } from "bun";
import { describe, expect, test } from "bun:test";
import { WebSocketBroadcaster, fileEventToMessage } from "../server/ws.ts";

/** Minimal stand-in for ServerWebSocket — only `send` is used by the broadcaster. */
function fakeSocket(): { ws: ServerWebSocket<unknown>; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    send: (data: string) => sent.push(data),
  } as unknown as ServerWebSocket<unknown>;
  return { ws, sent };
}

describe("WebSocketBroadcaster", () => {
  test("broadcasts JSON to every connected client", () => {
    const b = new WebSocketBroadcaster();
    const a = fakeSocket();
    const c = fakeSocket();
    b.add(a.ws);
    b.add(c.ws);
    expect(b.size).toBe(2);

    b.broadcast({ type: "hello", clients: 2 });

    expect(a.sent).toEqual([JSON.stringify({ type: "hello", clients: 2 })]);
    expect(c.sent).toEqual([JSON.stringify({ type: "hello", clients: 2 })]);
  });

  test("remove drops a client from future broadcasts", () => {
    const b = new WebSocketBroadcaster();
    const a = fakeSocket();
    b.add(a.ws);
    b.remove(a.ws);
    b.broadcast({ type: "hello", clients: 0 });
    expect(a.sent).toEqual([]);
    expect(b.size).toBe(0);
  });

  test("send-throw on one client does not break broadcast to the others", () => {
    const b = new WebSocketBroadcaster();
    const bad = {
      send: () => {
        throw new Error("socket closed");
      },
    } as unknown as ServerWebSocket<unknown>;
    const good = fakeSocket();
    b.add(bad);
    b.add(good.ws);
    b.broadcast({ type: "hello", clients: 2 });
    expect(good.sent.length).toBe(1);
  });
});

describe("fileEventToMessage", () => {
  test("maps watcher event onto wire shape", () => {
    const msg = fileEventToMessage({
      type: "change",
      path: "/abs/vault/tasks/x.md",
      relPath: "tasks/x.md",
      mtimeMs: 1234,
    });
    expect(msg).toEqual({
      type: "file_event",
      event: { kind: "change", relPath: "tasks/x.md", mtimeMs: 1234 },
    });
  });
});
