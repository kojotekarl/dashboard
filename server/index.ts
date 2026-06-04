import { basename } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import type { AgentProvider } from "./agent/AgentProvider.ts";
import { HermesAgent } from "./agent/HermesAgent.ts";
import { MockAgent } from "./agent/MockAgent.ts";
import { defaultRun } from "./agent/runner.ts";
import { handleGroom } from "./api/agent.ts";
import {
  handleApprove,
  handleApproveAll,
  handleDismiss,
  matchSuggestionAction,
} from "./api/suggestions.ts";
import { handleListTasks, handlePatchTask, matchTaskId } from "./api/tasks.ts";
import { type Config, loadConfig } from "./config.ts";
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

const agent: AgentProvider = await createAgent(config);

watcher.on(async (event) => {
  // Attach the post-change contentHash so clients can dedupe echoes against
  // their optimistic state (subagent #2 — version-token precedence).
  // Unlink events have no file to hash.
  let contentHash: string | undefined;
  if (event.type !== "unlink") {
    try {
      const file = await repo.peek(event.relPath);
      contentHash = file?.contentHash;
    } catch {
      // Best-effort; if the read races a subsequent change we just omit the hash.
    }
  }
  broadcaster.broadcast(fileEventToMessage(event, contentHash));
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

    if (url.pathname === "/api/tasks" && req.method === "GET") {
      return handleListTasks(repo);
    }

    const taskId = matchTaskId(url.pathname);
    if (taskId !== undefined && req.method === "PATCH") {
      return req
        .json()
        .catch(() => null)
        .then((body) => handlePatchTask(repo, taskId, body));
    }

    if (url.pathname === "/api/agent/groom" && req.method === "POST") {
      return handleGroom(repo, agent);
    }

    if (url.pathname === "/api/suggestions/approve-all" && req.method === "POST") {
      return handleApproveAll(repo);
    }

    const sugg = matchSuggestionAction(url.pathname);
    if (sugg !== undefined && req.method === "POST") {
      return sugg.action === "approve"
        ? handleApprove(repo, sugg.taskId)
        : handleDismiss(repo, sugg.taskId);
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
export { agent, broadcaster, repo, server, watcher };

// Graceful shutdown.
const shutdown = async (signal: string): Promise<void> => {
  log.info("shutting down", { signal });
  server.stop();
  await watcher.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ─── agent factory ──────────────────────────────────────────────────
//
// AGENT_PROVIDER=mock   -> MockAgent
// AGENT_PROVIDER=hermes -> HermesAgent wrapping MockAgent as fallback.
//                          Startup probes the hermes binary; if it's not
//                          reachable we still wire HermesAgent (it'll fall
//                          back automatically and surface a clear error
//                          in the groom summary), but we log a warning so
//                          the operator notices.
async function createAgent(cfg: Config): Promise<AgentProvider> {
  const mock = new MockAgent();
  if (cfg.agentProvider === "mock") {
    log.info("agent: MockAgent (deterministic, no external calls)");
    return mock;
  }
  const bin = cfg.hermesBin ?? "hermes";
  const probe = await defaultRun(bin, ["--version"], { timeoutMs: 5000 });
  if (probe.ok) {
    log.info("agent: HermesAgent", {
      bin,
      version: probe.stdout.trim().slice(0, 80),
      timeoutMs: cfg.hermesTimeoutMs,
    });
  } else {
    log.warn("agent: HermesAgent requested but `hermes --version` failed — calls will fall back to MockAgent", {
      bin,
      stderr: probe.stderr.trim().slice(0, 200),
    });
  }
  return new HermesAgent({
    bin,
    timeoutMs: cfg.hermesTimeoutMs,
    fallback: mock,
  });
}
