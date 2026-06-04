import { basename } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";

const config = loadConfig();
const vaultName = basename(config.vaultPath);

const server = Bun.serve({
  hostname: config.bindHost,
  port: config.port,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({
        ok: true,
        version: packageJson.version,
        agentProvider: config.agentProvider,
        vault: vaultName,
      });
    }

    return new Response("Not Found", { status: 404 });
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
