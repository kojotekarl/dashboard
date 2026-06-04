import { basename } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { MarkdownRepository } from "./repo/MarkdownRepository.ts";
import { VaultWatcher } from "./watcher.ts";
import { WebSocketBroadcaster, fileEventToMessage } from "./ws.ts";

const config = loadConfig();
const vaultName = basename(config.vaultPath);

const broadcaster = new WebSocketBroadcaster();
const watcher = new VaultWatcher(config.vaultPath);

// Repository writes call this immediately before the atomic rename, so the
// watcher does NOT echo our own change back to connected clients (which
// would clobber their optimistic UI state).
const repo = new MarkdownRepository(config.vaultPath, {
  beforeWrite: (path) => watcher.suppressNext(path),
});

watcher.on((event) => {
  broadcaster.broadcast(fileEventToMessage(event));
  log.debug("file event", { kind: event.type, relPath: event.relPath });
});

await watcher.start();

const server = Bun.serve({
  hostname: config.bindHost,
  port: config.port,
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        ok: true,
        version: packageJson.version,
        agentProvider: config.agentProvider,
        vault: vaultName,
        wsClients: broadcaster.size,
      });
    }

    if (url.pathname === "/api/ws") {
      const upgraded = srv.upgrade(req);
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      broadcaster.add(ws);
      ws.send(JSON.stringify({ type: "hello", clients: broadcaster.size }));
    },
    close(ws) {
      broadcaster.remove(ws);
    },
    // Clients don't send messages in v1; ignore anything that arrives.
    message() {},
  },
});

log.info("dashboard server listening", {
  url: `http://${server.hostname}:${server.port}`,
  vault: config.vaultPath,
  agentProvider: config.agentProvider,
  lanExposed: config.isLanExposed,
  authRequired: config.dashboardToken !== undefined,
});

if (config.isLanExposed) {
  log.warn("LAN-exposed: dashboard is reachable from your local network", {
    bindHost: config.bindHost,
    authRequired: true,
  });
}

// Expose the wired graph for tests / future server-side callers.
export { broadcaster, repo, server, watcher };

// Graceful shutdown.
const shutdown = async (signal: string): Promise<void> => {
  log.info("shutting down", { signal });
  server.stop();
  await watcher.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
